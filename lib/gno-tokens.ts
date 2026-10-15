import type { ChainConfig } from "@/lib/chains";
import { gnoHashToHex } from "@/lib/gno";
import { followEvents, type EventTx } from "@/lib/gno-follow";
import { gnoTxTimes } from "@/lib/gno-packages";

/**
 * GRC20 tokens on gno.land, from the events of gno.land/p/nt/grc20/v0, the
 * package every token is built on: NewToken (key, name, symbol, decimals),
 * Transfer (token, from, to, value; a mint has an empty from, a burn an empty
 * to) and Approval.
 *
 * Read from genesis and followed by followEvents. Balances are each
 * address's transfers in minus out, so they are exact as long as every event
 * since genesis is read; supply is mints minus burns.
 */

const GRC20 = "gno.land/p/nt/grc20/v0";
/** Transfers kept per token for its list, newest first. */
const RECENT = 300;

export interface TokenTransfer {
  /** Uppercase hex. */
  txHash: string;
  height: number;
  /** "" for a mint. */
  from: string;
  /** "" for a burn. */
  to: string;
  amount: bigint;
}

export interface GnoToken {
  /** The grc20 key: "gno.land/r/gnoswap/gns.GNS.0000000". */
  key: string;
  /** The realm that created it. */
  realm: string;
  name: string;
  symbol: string;
  decimals: number;
  createdHeight: number;
  /** Uppercase hex; null for a genesis token. */
  createdTx: string | null;
  supply: bigint;
  balances: Map<string, bigint>;
  transfers: number;
  /** Newest first, at most RECENT. */
  recent: TokenTransfer[];
}

export type { EventTx };

/** The token's realm and symbol from its key ("<realm>.<SYMBOL>.<seq>"). */
function splitKey(key: string): { realm: string; symbol: string } | null {
  const m = key.match(/^(gno\.land\/.+)\.([^./]+)\.([0-9a-f]+)$/);
  return m ? { realm: m[1], symbol: m[2] } : null;
}

function amountOf(v: string | undefined): bigint {
  try {
    return v && /^-?\d+$/.test(v) ? BigInt(v) : BigInt(0);
  } catch {
    return BigInt(0);
  }
}

/** Fold one window's transactions into the state. Exported for tests. */
export function applyGrc20(state: { tokens: Map<string, GnoToken> }, txs: EventTx[]) {
  for (const tx of txs) {
    const txHash = gnoHashToHex(tx.hash) ?? tx.hash;
    for (const e of tx.response?.events ?? []) {
      if (e.pkg_path !== GRC20 || !e.type) continue;
      const attr = (k: string) => e.attrs?.find((a) => a.key === k)?.value;
      const key = attr("token");
      if (!key) continue;
      if (e.type === "NewToken") {
        if (state.tokens.has(key)) continue;
        const parts = splitKey(key);
        state.tokens.set(key, {
          key,
          realm: parts?.realm ?? key,
          name: attr("name") ?? parts?.symbol ?? key,
          symbol: attr("symbol") ?? parts?.symbol ?? "",
          decimals: Number(attr("decimals") ?? 0) || 0,
          createdHeight: tx.block_height,
          createdTx: tx.block_height > 0 ? txHash : null,
          supply: BigInt(0),
          balances: new Map(),
          transfers: 0,
          recent: [],
        });
        continue;
      }
      if (e.type !== "Transfer") continue;
      const token = state.tokens.get(key);
      if (!token) continue;
      const from = attr("from") ?? "";
      const to = attr("to") ?? "";
      const amount = amountOf(attr("value"));
      if (from) {
        const left = (token.balances.get(from) ?? BigInt(0)) - amount;
        if (left === BigInt(0)) token.balances.delete(from);
        else token.balances.set(from, left);
      } else token.supply += amount;
      if (to) token.balances.set(to, (token.balances.get(to) ?? BigInt(0)) + amount);
      else token.supply -= amount;
      token.transfers += 1;
      token.recent.unshift({ txHash, height: tx.block_height, from, to, amount });
      if (token.recent.length > RECENT) token.recent.length = RECENT;
    }
  }
}

/**
 * Every token on the chain with its holders and recent transfers, brought up
 * to the indexer's head at most once a minute (see followEvents).
 */
export async function gnoTokens(chain: ChainConfig): Promise<Map<string, GnoToken> | null> {
  const state = await followEvents("tokens", chain, GRC20, () => ({ tokens: new Map<string, GnoToken>() }), applyGrc20);
  return state?.tokens ?? null;
}

/** The URL key for a token: its realm path without gno.land/, then its symbol. */
export function tokenHref(chainId: string, token: Pick<GnoToken, "realm" | "symbol">): string {
  return `/${chainId}/tokens/${token.realm.replace(/^gno\.land\//, "")}/${encodeURIComponent(token.symbol)}`;
}

/** The token a URL names, by realm and symbol. */
export function findToken(tokens: Map<string, GnoToken>, realm: string, symbol: string): GnoToken | null {
  for (const t of tokens.values()) if (t.realm === realm && t.symbol === symbol) return t;
  return null;
}

/** Holders, largest first. */
export function holdersOf(token: GnoToken, limit = 500): { address: string; balance: bigint }[] {
  return [...token.balances]
    .filter(([, b]) => b > BigInt(0))
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, limit)
    .map(([address, balance]) => ({ address, balance }));
}

/** Holder count: addresses with a positive balance. */
export function holderCount(token: GnoToken): number {
  let n = 0;
  for (const b of token.balances.values()) if (b > BigInt(0)) n += 1;
  return n;
}

/** An account's GRC20 balances, largest token first by holders. */
export function balancesOf(tokens: Map<string, GnoToken>, address: string): { token: GnoToken; balance: bigint }[] {
  const out: { token: GnoToken; balance: bigint }[] = [];
  for (const t of tokens.values()) {
    const b = t.balances.get(address);
    if (b && b > BigInt(0)) out.push({ token: t, balance: b });
  }
  return out;
}

/** Block times for a token's recent transfers, from the index. */
export function transferTimes(chainId: string, transfers: TokenTransfer[]): Promise<Map<string, string>> {
  return gnoTxTimes(chainId, [...new Set(transfers.map((t) => t.txHash))]);
}
