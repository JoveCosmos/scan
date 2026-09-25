import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";

/**
 * State sync: the fastest way to bring a node up, and the fiddliest to get
 * right by hand.
 *
 * An operator needs four things — two RPC servers, a recent height, that
 * block's hash, and a trust period. Three of the four are derived here rather
 * than written into config, because a trust height goes stale: a hash pinned in
 * a file is wrong within days, and a wrong `trust_hash` fails the sync with an
 * error that reads like a network problem. Recomputed on every page load, the
 * snippet is always current.
 *
 * The height is deliberately behind the head. State sync verifies against a
 * light-client header the servers must still be able to serve, and a height at
 * or near the tip can be reorganised out from under the sync.
 */

const TRUST_LAG = 2000;
const DEFAULT_TRUST_PERIOD = "8h0m0s";

export interface StateSync {
  rpcServers: string[];
  trustHeight: number;
  /** Hex, uppercase — the form CometBFT's config expects. */
  trustHash: string;
  trustPeriod: string;
  /** Ready to paste into config.toml. */
  snippet: string;
}

interface BlockIdResponse {
  block_id?: { hash?: string };
  block?: { header?: { height?: string } };
}

/**
 * The LCD renders a block hash base64; `config.toml` wants uppercase hex. They
 * are the same 32 bytes, and getting this wrong is a sync that never starts.
 */
function toHex(base64: string): string | null {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) return null;
  return raw.toString("hex").toUpperCase();
}

export async function getStateSync(
  chain: ChainConfig,
  rpcServers: string[],
  trustPeriod = DEFAULT_TRUST_PERIOD
): Promise<StateSync | null> {
  if (rpcServers.length === 0) return null;

  return cached(`statesync:${chain.chainId}`, 60_000, async () => {
    const latest = await fetchLcd<BlockIdResponse>(
      chain,
      "/cosmos/base/tendermint/v1beta1/blocks/latest",
      { cache: "no-store", timeoutMs: 8000 }
    );

    const head = Number(latest.block?.header?.height);
    if (!Number.isFinite(head)) return null;

    // Rounded to a thousand as well as lagged: a round number is easier to
    // recognise as deliberate when someone reads it back out of their config.
    const trustHeight = Math.max(1, Math.floor((head - TRUST_LAG) / 1000) * 1000);

    const trusted = await fetchLcd<BlockIdResponse>(
      chain,
      `/cosmos/base/tendermint/v1beta1/blocks/${trustHeight}`,
      { cache: "no-store", timeoutMs: 8000 }
    );

    const hash = trusted.block_id?.hash ? toHex(trusted.block_id.hash) : null;
    if (!hash) return null;

    // Two servers, because CometBFT requires at least two and will refuse to
    // start with one. A single published endpoint is listed twice, which it
    // accepts and which is what every chain's own documentation tells you to do.
    const servers = rpcServers.length >= 2 ? rpcServers.slice(0, 2) : [rpcServers[0], rpcServers[0]];

    const snippet = [
      `[statesync]`,
      `enable = true`,
      `rpc_servers = "${servers.join(",")}"`,
      `trust_height = ${trustHeight}`,
      `trust_hash = "${hash}"`,
      `trust_period = "${trustPeriod}"`,
    ].join("\n");

    return { rpcServers: servers, trustHeight, trustHash: hash, trustPeriod, snippet };
  });
}
