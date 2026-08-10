import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";
import { getAllChains } from "@/lib/chains";

/**
 * IBC channels, and the operators who keep packets moving across them.
 *
 * Two sources, deliberately. Channels come from the chain itself and work
 * anywhere. Relayer operators and their volumes come from the indexer, because
 * "who relayed how much" is a question about transaction history that no node
 * will answer — it requires attributing every IBC message to its signer across
 * the whole chain.
 *
 * So a chain we have not indexed shows its channels and says plainly that the
 * operator table needs an index, rather than showing an empty table that reads
 * as "nobody relays here".
 */

/** Messages only a relayer submits. Transfers are excluded on purpose: the
 *  sender of a MsgTransfer is a user moving their own funds, not an operator. */
export const RELAYER_MSG_TYPES = [
  "/ibc.core.channel.v1.MsgRecvPacket",
  "/ibc.core.channel.v1.MsgAcknowledgement",
  "/ibc.core.channel.v1.MsgTimeout",
  "/ibc.core.channel.v1.MsgTimeoutOnClose",
  "/ibc.core.client.v1.MsgUpdateClient",
];

export interface IbcChannel {
  channelId: string;
  portId: string;
  state: string;
  ordering: string;
  counterpartyChannelId: string;
  counterpartyPortId: string;
  connectionId: string;
  /** Resolved from the channel's client state, when we could read it. */
  counterpartyChainId: string | null;
  /** The counterparty's pretty name, when it is a chain this explorer knows. */
  counterpartyName: string | null;
}

interface RawChannel {
  state?: string;
  ordering?: string;
  counterparty?: { port_id?: string; channel_id?: string };
  connection_hops?: string[];
  port_id?: string;
  channel_id?: string;
}

/** Trim the SDK's verbose enum names down to something readable. */
function shortState(state: string | undefined): string {
  return (state ?? "").replace(/^STATE_/, "").toLowerCase();
}

function shortOrdering(ordering: string | undefined): string {
  return (ordering ?? "").replace(/^ORDER_/, "").toLowerCase();
}

/**
 * Every channel on the chain, open ones first.
 *
 * Paged in full rather than reading one page: a chain like Osmosis has hundreds
 * of channels, and an arbitrary first page would put whichever the module
 * happened to return first at the top of the table.
 */
export async function getChannels(chain: ChainConfig): Promise<IbcChannel[]> {
  return cached(`ibc:channels:${chain.chainId}`, 600_000, async () => {
    const raw: RawChannel[] = [];
    let nextKey: string | null = null;

    // Bounded: a broken pagination key must not spin forever.
    for (let page = 0; page < 20; page++) {
      const res: {
        channels?: RawChannel[];
        pagination?: { next_key?: string | null };
      } = await fetchLcd(chain, "/ibc/core/channel/v1/channels", {
        timeoutMs: 15_000,
        searchParams: {
          "pagination.limit": 200,
          ...(nextKey ? { "pagination.key": nextKey } : {}),
        },
      });
      raw.push(...(res.channels ?? []));
      nextKey = res.pagination?.next_key || null;
      if (!nextKey) break;
    }

    const channels: IbcChannel[] = raw.map((c) => ({
      channelId: c.channel_id ?? "",
      portId: c.port_id ?? "",
      state: shortState(c.state),
      ordering: shortOrdering(c.ordering),
      counterpartyChannelId: c.counterparty?.channel_id ?? "",
      counterpartyPortId: c.counterparty?.port_id ?? "",
      connectionId: c.connection_hops?.[0] ?? "",
      counterpartyChainId: null,
      counterpartyName: null,
    }));

    return sortChannels(channels);
  }).catch(() => []);
}

/**
 * Open channels first, then in channel-number order.
 *
 * Exported for tests because the ordering is the one piece of real logic here:
 * sorting these as strings puts channel-100 above channel-9, which looks
 * plausible enough on a chain with a handful of channels and is wrong on every
 * chain with more.
 */
export function sortChannels(channels: IbcChannel[]): IbcChannel[] {
  return [...channels].sort((a, b) => {
    const aOpen = a.state === "open";
    const bOpen = b.state === "open";
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return channelNumber(a.channelId) - channelNumber(b.channelId);
  });
}

function channelNumber(id: string): number {
  const n = Number(id.replace(/^channel-/, ""));
  // Unparseable ids sink to the bottom rather than sorting as NaN, which
  // compares false against everything and leaves order undefined.
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Which chain sits on the other end, from each channel's client state.
 *
 * One request per channel, so it is done for a bounded slice and only for open
 * channels — resolving several hundred counterparties would take longer than
 * the page is worth, and a closed channel's counterparty is of no use to
 * anyone.
 */
export async function resolveCounterparties(
  chain: ChainConfig,
  channels: IbcChannel[],
  limit = 60
): Promise<IbcChannel[]> {
  const known = new Map(
    getAllChains().map((c) => [c.chainId, c.prettyName] as const)
  );

  const targets = channels.filter((c) => c.state === "open").slice(0, limit);
  const CONCURRENCY = 8;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const slice = targets.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (ch) => {
        const chainId = await counterpartyChainId(chain, ch);
        ch.counterpartyChainId = chainId;
        ch.counterpartyName = chainId ? (known.get(chainId) ?? null) : null;
      })
    );
  }

  return channels;
}

async function counterpartyChainId(
  chain: ChainConfig,
  ch: IbcChannel
): Promise<string | null> {
  // Cached hard and per channel: a channel's counterparty never changes.
  return cached(
    `ibc:client:${chain.chainId}:${ch.portId}:${ch.channelId}`,
    3_600_000,
    async () => {
      const res: {
        identified_client_state?: { client_state?: { chain_id?: string } };
      } = await fetchLcd(
        chain,
        `/ibc/core/channel/v1/channels/${ch.channelId}/ports/${ch.portId}/client_state`,
        { timeoutMs: 10_000 }
      );
      return res.identified_client_state?.client_state?.chain_id ?? null;
    }
  ).catch(() => null);
}
