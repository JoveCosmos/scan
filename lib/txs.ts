import { createHash } from "node:crypto";
import { chainDenoms, getAllChains, type ChainConfig } from "@/lib/chains";
import { resolveIbcDenoms } from "@/lib/ibc";
import { denomInfoFromTrace, type DenomInfo } from "@/lib/coin";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";
import { recentFacts } from "@/lib/block-facts";
import {
  indexerFreshness,
  recentTxsFromIndexer,
  type IndexedAccountTx,
} from "@/lib/indexer-db";
import { isCosmosTxHash } from "@/lib/input";
import {
  multiSendIO,
  partiesOf,
  primaryTransfer,
  transferOf,
  type MultiSendIO,
  type PartyRole,
  type RawMessage,
  type TxTransfer,
} from "@/lib/tx-parties";
import {
  decodeMessage,
  isBookkeeping,
  labelForType as decodeLabel,
  mergeCoins,
  parseCoinString,
  prettyJson,
  type DecodedField,
} from "@/lib/msg-decode";

export interface TxMessage {
  typeUrl: string;
  label: string;
  /** Parties and amount, where the message type has them. */
  transfer: TxTransfer | null;
  /** Who the message names, by role. Absent on gno and indexed rows. */
  parties?: PartyRole[];
  /** A multi-send's inputs and outputs. */
  io?: MultiSendIO | null;
  /** Labelled fields for the transaction page. Detail reads only. */
  fields?: DecodedField[];
  /** An authz MsgExec's inner messages. */
  inner?: TxMessage[];
}

export interface TxEvent {
  type: string;
  attributes: { key: string; value: string }[];
  /** Which message emitted it; null for fee and signature events. */
  msgIndex: number | null;
}

export interface TxSummary {
  hash: string;
  height: string;
  time: string | null;
  /** ABCI result code; 0 is success. null when only the hash is known. */
  code: number | null;
  /** Top-level messages; an authz exec carries its inner messages beneath. */
  messages: TxMessage[];
  messageCount: number;
  /** One-line summary of what the transaction moved, for list views. */
  transfer: TxTransfer | null;
  /** The message a list should name: skips relayer client updates. */
  primaryLabel?: string;
  fee: { denom: string; amount: string }[];
  gasUsed: string | null;
  gasWanted: string | null;
  memo: string;
  /** Who signed; filled where the source says so. */
  signer?: string | null;
}

export interface TxDetail extends TxSummary {
  rawLog: string;
  signers: string[];
  timeoutHeight: string | null;
  codespace?: string | null;
  feePayer?: string | null;
  feeGranter?: string | null;
  gasLimit?: string | null;
  events?: TxEvent[];
  /** The node's response as pretty JSON, very long strings elided. */
  rawJson?: string;
}

export interface RawTxResponse {
  txhash: string;
  height: string;
  code: number;
  codespace?: string;
  gas_used: string;
  gas_wanted: string;
  timestamp: string;
  raw_log: string;
  events?: { type: string; attributes?: { key: string; value: string }[] }[];
  logs?: { msg_index?: number; events?: { type: string; attributes?: { key: string; value: string }[] }[] }[];
  tx?: {
    body?: {
      messages?: { "@type": string }[];
      memo?: string;
      timeout_height?: string;
    };
    auth_info?: {
      fee?: {
        amount?: { denom: string; amount: string }[];
        gas_limit?: string;
        payer?: string;
        granter?: string;
      };
      signer_infos?: unknown[];
    };
  };
}

interface TxsByHeightResponse {
  tx_responses?: RawTxResponse[];
}
interface SingleTxResponse {
  tx_response?: RawTxResponse;
}
/**
 * A Cosmos tx hash is the SHA-256 of the raw (base64) tx bytes as included in the
 * block — verified to match the node's own `txhash`. Computing it locally means
 * the tx list still works against nodes with transaction indexing switched off.
 */
export function txHashFromBase64(rawTx: string): string {
  return createHash("sha256")
    .update(Buffer.from(rawTx, "base64"))
    .digest("hex")
    .toUpperCase();
}

/** "/cosmos.bank.v1beta1.MsgSend" -> "Send". Kept here for existing importers. */
export function labelForType(typeUrl: string): string {
  return decodeLabel(typeUrl);
}

/**
 * The response's events, each tagged with the message that emitted it. Newer
 * SDKs put a msg_index attribute on every message event; older ones group
 * them per message under `logs`. Both land in the same shape.
 */
export function eventsOf(raw: RawTxResponse): TxEvent[] {
  const logs = raw.logs ?? [];
  if (logs.length > 0 && logs.some((l) => (l.events ?? []).length > 0)) {
    const txLevel: TxEvent[] = (raw.events ?? [])
      .filter((e) => e.type === "tx" || e.type === "fee_pay" || e.type === "use_feegrant")
      .map((e) => ({ type: e.type, attributes: e.attributes ?? [], msgIndex: null }));
    return [
      ...txLevel,
      ...logs.flatMap((l, i) =>
        (l.events ?? []).map((e) => ({
          type: e.type,
          attributes: e.attributes ?? [],
          msgIndex: l.msg_index ?? i,
        }))
      ),
    ];
  }
  return (raw.events ?? []).map((e) => {
    const attrs = e.attributes ?? [];
    const idx = attrs.find((a) => a.key === "msg_index")?.value;
    return {
      type: e.type,
      attributes: attrs.filter((a) => a.key !== "msg_index"),
      msgIndex: idx !== undefined && /^\d+$/.test(idx) ? Number(idx) : null,
    };
  });
}

function flatAttrs(e: TxEvent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of e.attributes) if (!(a.key in out)) out[a.key] = a.value;
  return out;
}

function ctxFor(events: TxEvent[], index: number) {
  return {
    events: events
      .filter((e) => e.msgIndex === index)
      .map((e) => ({ type: e.type, attributes: flatAttrs(e) })),
  };
}

/** Rewards and commission a message paid out, from its events. */
function payoutFor(events: TxEvent[], index: number, type: string): { denom: string; amount: string }[] {
  const kind = /MsgWithdrawValidatorCommission$/.test(type) ? "withdraw_commission" : "withdraw_rewards";
  return mergeCoins(
    events
      .filter((e) => e.msgIndex === index && e.type === kind)
      .flatMap((e) => parseCoinString(flatAttrs(e).amount))
  );
}

function toTxMessage(
  chainId: string,
  m: RawMessage,
  index: number,
  events: TxEvent[],
  detail: boolean
): TxMessage {
  let transfer = transferOf(m);
  // A claim's amount lives only in its events.
  if (transfer && transfer.amount.length === 0 && /MsgWithdraw(DelegatorReward|ValidatorCommission)$/.test(m["@type"])) {
    transfer = { ...transfer, amount: payoutFor(events, index, m["@type"]) };
  }
  const inner =
    /MsgExec$/.test(m["@type"]) && m.msgs
      ? m.msgs.map((x) => toTxMessage(chainId, x, index, events, detail))
      : undefined;
  return {
    typeUrl: m["@type"],
    label: labelForType(m["@type"]),
    transfer,
    parties: partiesOf(m),
    io: multiSendIO(m),
    ...(detail
      ? { fields: decodeMessage(chainId, m["@type"], m as unknown as Record<string, unknown>, ctxFor(events, index)).fields }
      : {}),
    ...(inner ? { inner } : {}),
  };
}

/** The message a one-line summary should name. */
function primaryOf(messages: TxMessage[]): TxMessage | undefined {
  const main = messages.find((m) => !isBookkeeping(m.typeUrl)) ?? messages[0];
  if (main?.inner?.length) return main.inner.find((m) => !isBookkeeping(m.typeUrl)) ?? main.inner[0];
  return main;
}

/** Shared with the account history reader, which hits the same tx endpoint. */
export function rawTxToSummary(raw: RawTxResponse, chainId = "", detail = false): TxSummary {
  const top = (raw.tx?.body?.messages ?? []) as RawMessage[];
  const events = eventsOf(raw);
  const messages = top.map((m, i) => toTxMessage(chainId, m, i, events, detail));
  const primary = primaryOf(messages);
  const flatTransfers = primaryTransfer(top);

  const signer =
    events
      .filter((e) => e.type === "tx")
      .map((e) => flatAttrs(e).acc_seq)
      .find(Boolean)
      ?.split("/")[0] ?? null;

  return {
    hash: raw.txhash,
    height: raw.height,
    time: raw.timestamp ?? null,
    code: raw.code ?? 0,
    messages,
    messageCount: messages.length,
    transfer:
      primary?.transfer && primary.transfer.amount.length > 0
        ? primary.transfer
        : flatTransfers ?? primary?.transfer ?? null,
    primaryLabel: primary
      ? messages.length > 1
        ? `${primary.label} +${messages.length - 1}`
        : primary.label
      : undefined,
    fee: raw.tx?.auth_info?.fee?.amount ?? [],
    gasUsed: raw.gas_used ?? null,
    gasWanted: raw.gas_wanted ?? null,
    memo: raw.tx?.body?.memo ?? "",
    signer,
  };
}

export function txsAtHeight(
  chain: ChainConfig,
  height: string,
  fallbackRawTxs: string[],
  blockTime: string
): Promise<TxSummary[]> {
  return txsAtHeightByHash(chain, height, fallbackRawTxs.map(txHashFromBase64), blockTime);
}

class DegradedRead extends Error {
  constructor(public readonly txs: TxSummary[]) {
    super("degraded");
  }
}
const fallbackAt = new Map<string, { until: number; txs: TxSummary[] }>();

/**
 * A committed block's transactions never change, so they are cached by height:
 * the feed polls every few seconds and should only ever resolve new blocks.
 */
function txsAtHeightByHash(
  chain: ChainConfig,
  height: string,
  fallbackHashes: string[],
  blockTime: string
): Promise<TxSummary[]> {
  // A committed block never changes, but a node hiccup does not deserve to be
  // remembered: the real read is kept for half an hour, the hashes-only
  // fallback for seconds, so the next poll tries the node again.
  const key = `txsat:${chain.chainId}:${height}`;
  const degraded = fallbackAt.get(key);
  if (degraded && degraded.until > Date.now()) return Promise.resolve(degraded.txs);
  return cached(key, 30 * 60_000, async () => {
    const txs = await readTxsAtHeight(chain, height, fallbackHashes, blockTime);
    if (txs.some((t) => t.code === null)) {
      if (fallbackAt.size > 2000) fallbackAt.clear();
      fallbackAt.set(key, { until: Date.now() + 15_000, txs });
      throw new DegradedRead(txs);
    }
    return txs;
  }).catch((err: unknown) => {
    if (err instanceof DegradedRead) return err.txs;
    throw err;
  });
}

async function readTxsAtHeight(
  chain: ChainConfig,
  height: string,
  fallbackHashes: string[],
  blockTime: string
): Promise<TxSummary[]> {
  try {
    const res = await fetchLcd<TxsByHeightResponse>(chain, "/cosmos/tx/v1beta1/txs", {
      cache: "no-store",
      timeoutMs: 8000,
      searchParams: { query: `tx.height=${height}`, "pagination.limit": 100 },
    });
    if (res.tx_responses?.length) return res.tx_responses.map((r) => rawTxToSummary(r, chain.chainId));
  } catch {
    // Indexing disabled or endpoint unhappy — fall through to hashes-only.
  }

  // Degraded mode: we still know each tx's hash and which block it landed in,
  // which is enough to list it and link to its detail page.
  return fallbackHashes.map((hash) => ({
    hash,
    height,
    time: blockTime,
    code: null,
    messages: [],
    messageCount: 0,
    transfer: null,
    fee: [],
    gasUsed: null,
    gasWanted: null,
    memo: "",
  }));
}

/**
 * Recent transactions, assembled by walking back from the head block. There is no
 * "latest transactions" endpoint in the Cosmos REST API, and chains vary wildly in
 * throughput, so we scan a bounded window of blocks and stop once we have enough.
 */
/**
 * An indexed row in the shape the list views already render.
 *
 * Shared by the account history and the recent-transactions tab, which read
 * the same columns and differ only in what they select on.
 *
 * The index stores extracted facts rather than transaction bodies, so a few
 * fields a raw tx would carry are absent — memos, message bodies. Gas and the
 * signer are kept and come through.
 */
export function indexedTxToSummary(t: IndexedAccountTx): TxSummary {
  return {
    hash: t.hash,
    height: t.height,
    time: t.time,
    code: t.code,
    messages: t.msgTypes.map((typeUrl) => ({
      typeUrl,
      label: labelForType(typeUrl),
      // Per-message parties are not indexed; the tx-level transfer below
      // carries the movement this account was party to.
      transfer: null,
    })),
    messageCount: t.msgTypes.length,
    transfer: t.transfer
      ? {
          from: t.transfer.from,
          to: t.transfer.to,
          amount: [{ denom: t.transfer.denom, amount: t.transfer.amount }],
          // Bank transfers between accounts; staking movements are their own
          // event kinds and are not matched here.
          staking: false,
        }
      : null,
    fee:
      t.feeDenom && t.feeAmount
        ? [{ denom: t.feeDenom, amount: t.feeAmount }]
        : [],
    gasUsed: t.gasUsed ?? null,
    gasWanted: t.gasWanted ?? null,
    memo: "",
    signer: t.signer ?? null,
  };
}

export async function getRecentTxs(
  chain: ChainConfig,
  { maxTxs = 30, maxBlocks = 30 }: { maxTxs?: number; maxBlocks?: number } = {}
): Promise<{ txs: TxSummary[]; scannedBlocks: number; headHeight: string | null; stale?: boolean }> {
  // Indexed first. Scanning a block window answers "what happened lately"; on a
  // chain with mostly empty blocks that shows two transactions while thousands
  // exist, because the window is the limit rather than the activity.
  const [indexed, freshAt] = await Promise.all([
    recentTxsFromIndexer(chain.chainId, maxTxs).catch(() => null),
    indexerFreshness(chain.chainId),
  ]);
  // A follower that stopped advancing would otherwise keep serving its last
  // rows as "latest". Past ten minutes, the live block window takes over.
  const indexFresh = freshAt !== null && Date.now() - freshAt.getTime() < 10 * 60_000;
  if (indexed && indexed.length > 0 && indexFresh) {
    return {
      txs: indexed.map(indexedTxToSummary),
      // Not a window — these are the last transactions, not a slice of blocks.
      scannedBlocks: 0,
      headHeight: indexed[0]?.height ?? null,
    };
  }

  // The same cached heights the blocks feed reads, so between them each block
  // is fetched once and each block's transactions resolved once.
  let facts;
  try {
    facts = await recentFacts(chain, maxBlocks);
  } catch {
    return { txs: [], scannedBlocks: 0, headHeight: null };
  }
  const headHeight = facts[0]?.summary.height ?? null;
  // An endpoint serving a stale head (seen once: a 107-day-old window on a
  // testnet) must not present old transactions as the latest.
  const headTime = facts[0]?.summary.time ? Date.parse(facts[0].summary.time) : NaN;
  if (Number.isFinite(headTime) && Date.now() - headTime > 6 * 3_600_000) {
    return { txs: [], scannedBlocks: 0, headHeight, stale: true };
  }

  // Newest first; take enough blocks to satisfy maxTxs, then resolve them in
  // parallel — sequentially cost several seconds on chains with sparse blocks.
  const needed: typeof facts = [];
  let running = 0;
  for (const block of facts) {
    if (block.txHashes.length === 0) continue;
    if (running >= maxTxs) break;
    needed.push(block);
    running += block.txHashes.length;
  }

  const resolved = await Promise.all(
    needed.map((block) =>
      txsAtHeightByHash(chain, block.summary.height, block.txHashes, block.summary.time)
    )
  );

  return {
    txs: resolved.flat().slice(0, maxTxs),
    scannedBlocks: facts.length,
    headHeight,
  };
}

/** The node answered, but not with the transaction: not found, not failed. */
export class TxLookupError extends Error {}

export async function getTx(
  chain: ChainConfig,
  hash: string
): Promise<TxDetail | null> {
  // Hashes are interpolated into an LCD path. See lib/input.ts.
  if (!isCosmosTxHash(hash)) return null;

  let res: SingleTxResponse;
  try {
    res = await fetchLcd<SingleTxResponse>(
      chain,
      `/cosmos/tx/v1beta1/txs/${hash.toUpperCase()}`,
      { cache: "no-store", timeoutMs: 10_000 }
    );
  } catch (err) {
    // A 404 from the node is its answer: no such transaction. Anything else
    // is the node failing, which must not read as "not found".
    const cause = (err as { cause?: unknown }).cause;
    if (String((cause as Error | undefined)?.message ?? "").includes("responded 404")) return null;
    throw new TxLookupError(`tx lookup failed on ${chain.chainId}`);
  }
  if (!res.tx_response) return null;

  const raw = res.tx_response;
  const events = eventsOf(raw);
  const txEvents = events.filter((e) => e.type === "tx").map(flatAttrs);
  const signers = [
    ...new Set(
      txEvents
        .map((a) => a.acc_seq?.split("/")[0])
        .filter((a): a is string => !!a)
    ),
  ];
  const fee = raw.tx?.auth_info?.fee;
  const feePayer =
    fee?.payer || txEvents.map((a) => a.fee_payer).find(Boolean) || signers[0] || null;
  const feeGranter =
    fee?.granter ||
    events
      .filter((e) => e.type === "use_feegrant")
      .map((e) => flatAttrs(e).granter)
      .find(Boolean) ||
    null;

  return {
    ...rawTxToSummary(raw, chain.chainId, true),
    rawLog: raw.raw_log ?? "",
    signers,
    signer: signers[0] ?? null,
    timeoutHeight: raw.tx?.body?.timeout_height ?? null,
    codespace: raw.codespace || null,
    feePayer,
    feeGranter,
    gasLimit: fee?.gas_limit ?? null,
    events,
    rawJson: prettyJson(raw),
  };
}

// ------------------------------------------------------------------ IBC

export interface IbcCounterpart {
  /** Message index on this transaction. */
  index: number;
  counterpartyChainId: string | null;
  /** Set when we carry the counterparty chain. */
  counterpartyName: string | null;
  /** The matching transaction on the other chain, when found. */
  txHash: string | null;
  /** What the other transaction is: the receive, or the original send. */
  role: "receive" | "send";
}

interface ClientStateResponse {
  identified_client_state?: { client_state?: { chain_id?: string } };
}

/** The chain on the other end of one of our channels. Never changes; cached a day. */
function counterpartyChainOf(chain: ChainConfig, port: string, channel: string): Promise<string | null> {
  return cached(`ibc-cp:${chain.chainId}:${port}:${channel}`, 24 * 3_600_000, async () => {
    try {
      const res = await fetchLcd<ClientStateResponse>(
        chain,
        `/ibc/core/channel/v1/channels/${encodeURIComponent(channel)}/ports/${encodeURIComponent(port)}/client_state`,
        { cache: "no-store", timeoutMs: 6000 }
      );
      return res.identified_client_state?.client_state?.chain_id ?? null;
    } catch {
      return null;
    }
  });
}

/**
 * Find one packet's transaction on another chain by its event. SDK 0.50 takes
 * `query=`; older nodes only `events=`, one condition, so the channel is then
 * checked on the results.
 */
async function findPacketTx(
  target: ChainConfig,
  event: "recv_packet" | "send_packet",
  srcChannel: string,
  sequence: string
): Promise<string | null> {
  const key = `ibc-tx:${target.chainId}:${event}:${srcChannel}:${sequence}`;
  return cached(key, 10 * 60_000, async () => {
    const match = (r: RawTxResponse) =>
      eventsOf(r).some((e) => {
        if (e.type !== event) return false;
        const a = flatAttrs(e);
        return a.packet_sequence === sequence && a.packet_src_channel === srcChannel;
      });
    const attempts: Record<string, string>[] = [
      { query: `${event}.packet_sequence='${sequence}' AND ${event}.packet_src_channel='${srcChannel}'` },
      { events: `${event}.packet_sequence='${sequence}'` },
    ];
    for (const params of attempts) {
      try {
        const res = await fetchLcd<TxsByHeightResponse>(target, "/cosmos/tx/v1beta1/txs", {
          cache: "no-store",
          timeoutMs: 6000,
          deadlineMs: 8000,
          searchParams: { ...params, "pagination.limit": 20 },
        });
        const hit = (res.tx_responses ?? []).find(match);
        if (hit) return hit.txhash;
      } catch {
        /* try the older form */
      }
    }
    return null;
  });
}

/**
 * For each IBC message, the chain on the other end and the matching
 * transaction there: a transfer's receive, a receive's original send, an
 * acknowledgement's receive. Only chains we carry can be searched.
 */
export async function ibcCounterparts(
  chain: ChainConfig,
  tx: TxDetail,
  carried: ChainConfig[]
): Promise<IbcCounterpart[]> {
  const raw = JSON.parse(tx.rawJson ?? "{}") as RawTxResponse;
  const top = (raw.tx?.body?.messages ?? []) as (RawMessage & Record<string, unknown>)[];
  const events = tx.events ?? [];

  const jobs = top.map(async (m, index): Promise<IbcCounterpart | null> => {
    const type = m["@type"].split(".").pop() ?? "";
    let localPort: string | undefined;
    let localChannel: string | undefined;
    let searchEvent: "recv_packet" | "send_packet";
    let srcChannel: string | undefined;
    let sequence: string | undefined;

    if (type === "MsgTransfer") {
      const send = events.find((e) => e.msgIndex === index && e.type === "send_packet");
      const a = send ? flatAttrs(send) : {};
      localPort = (m.source_port as string) ?? "transfer";
      localChannel = m.source_channel as string;
      searchEvent = "recv_packet";
      srcChannel = localChannel;
      sequence = a.packet_sequence;
    } else if (/^Msg(RecvPacket|Acknowledgement|Timeout|TimeoutOnClose)$/.test(type)) {
      const p = (m.packet ?? {}) as Record<string, string>;
      sequence = p.sequence;
      if (type === "MsgRecvPacket") {
        localPort = p.destination_port;
        localChannel = p.destination_channel;
        searchEvent = "send_packet";
        srcChannel = p.source_channel;
      } else {
        localPort = p.source_port;
        localChannel = p.source_channel;
        searchEvent = "recv_packet";
        srcChannel = p.source_channel;
      }
    } else {
      return null;
    }
    if (!localPort || !localChannel) return null;

    const cpId = await counterpartyChainOf(chain, localPort, localChannel);
    const cp = cpId ? carried.find((c) => c.chainId === cpId && c.kind === "cosmos") : undefined;
    const txHash =
      cp && srcChannel && sequence ? await findPacketTx(cp, searchEvent!, srcChannel, sequence) : null;
    return {
      index,
      counterpartyChainId: cpId,
      counterpartyName: cp?.prettyName ?? null,
      txHash,
      role: searchEvent! === "recv_packet" ? "receive" : "send",
    };
  });

  return (await Promise.all(jobs)).filter((x): x is IbcCounterpart => x !== null);
}

// ---------------------------------------------------------------- denoms

function coinsIn(tx: TxSummary): string[] {
  const out: string[] = tx.fee.map((c) => c.denom);
  const walk = (ms: TxMessage[]) => {
    for (const m of ms) {
      out.push(...(m.transfer?.amount ?? []).map((c) => c.denom));
      for (const f of m.fields ?? []) if (f.value.kind === "coins") out.push(...f.value.coins.map((c) => c.denom));
      if (m.inner) walk(m.inner);
    }
  };
  walk(tx.messages);
  return out;
}

/**
 * Display info for every denom these transactions mention: the chain's own,
 * then IBC denoms resolved through their traces, so "ibc/27394F…" reads as the
 * token it is. Unresolvable denoms are left to show raw.
 */
export async function denomsForTxs(chain: ChainConfig, txs: TxSummary[]): Promise<DenomInfo[]> {
  const own = chainDenoms(chain);
  const all = [...new Set(txs.flatMap(coinsIn))];
  const ibc = all.filter((d) => d.startsWith("ibc/"));
  if (ibc.length === 0) return own;
  const carried = getAllChains().flatMap(chainDenoms);
  const traces = await resolveIbcDenoms(chain, ibc).catch(() => new Map());
  const extra: DenomInfo[] = [];
  for (const [denom, trace] of traces) {
    const info = denomInfoFromTrace(denom, trace, carried);
    if (info) extra.push(info);
  }
  return [...own, ...extra];
}
