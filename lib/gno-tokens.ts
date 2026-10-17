import type { ChainConfig } from "@/lib/chains";
import { gnoHashToHex, gql } from "@/lib/gno";
import { cached } from "@/lib/cache";
import { followEvents, type EventTx } from "@/lib/gno-follow";

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

export interface AccountTransfer {
  /** Uppercase hex. */
  txHash: string;
  height: number;
  /** The token's key, "<realm>.<SYMBOL>.<seq>". */
  token: string;
  /** "" for a mint. */
  from: string;
  /** "" for a burn. */
  to: string;
  /** Base units, as a decimal string. */
  amount: string;
}

/** Transfers on one page of an account's Token transfers tab. */
export const ACCOUNT_TRANSFERS_PAGE = 100;

/** GRC20 transfers naming an address, in a height range, newest first. */
const accountQuery = (bounded: boolean) => `query(${bounded ? "$a: Int!, " : ""}$b: Int!, $x: String!) {
  getTransactions(where: { success: { eq: true }, block_height: { ${bounded ? "gt: $a, " : ""}lt: $b },
    response: { events: { GnoEvent: { pkg_path: { eq: "${GRC20}" }, type: { eq: "Transfer" }, attrs: { value: { eq: $x } } } } } },
    order: { heightAndIndex: DESC }) {
    hash block_height
    response { events { ... on GnoEvent { type pkg_path attrs { key value } } } }
  }
}`;

/**
 * A page of an account's GRC20 transfers below block `before` (from the
 * chain's head when absent), newest first: read down in height windows
 * (widened while empty, halved when one comes back full) until a page is
 * filled, and ended on a whole block so the next page can start below it.
 * `next` is the height to continue below, or null once genesis is reached.
 */
export async function gnoAccountTransfers(
  chain: ChainConfig,
  address: string,
  before?: number
): Promise<{ transfers: AccountTransfer[]; next: number | null } | null> {
  const load = async () => {
    const start = before ?? (await gql<{ latestBlockHeight: number }>(chain, "{ latestBlockHeight }")).latestBlockHeight + 1;
    const found: AccountTransfer[] = [];
    let hi = start;
    let window = 100_000;
    while (hi > 0 && found.length < ACCOUNT_TRANSFERS_PAGE) {
      const lo = Math.max(0, hi - window);
      const data = await gql<{ getTransactions: EventTx[] | null }>(
        chain,
        accountQuery(lo > 0),
        lo > 0 ? { a: lo - 1, b: hi, x: address } : { b: hi, x: address },
        30_000
      );
      const txs = data.getTransactions ?? [];
      if (txs.length >= 10_000 && hi - lo > 1) {
        window = Math.max(1, Math.floor((hi - lo) / 2));
        continue;
      }
      for (const tx of txs) {
        const txHash = gnoHashToHex(tx.hash) ?? tx.hash;
        for (const e of tx.response?.events ?? []) {
          if (e.pkg_path !== GRC20 || e.type !== "Transfer") continue;
          const attr = (k: string) => e.attrs?.find((a) => a.key === k)?.value ?? "";
          const from = attr("from");
          const to = attr("to");
          if (from !== address && to !== address) continue;
          found.push({ txHash, height: tx.block_height, token: attr("token"), from, to, amount: attr("value") });
        }
      }
      hi = lo;
      if (txs.length === 0) window = Math.min(window * 4, 400_000);
    }
    // End the page on a whole block.
    let end = Math.min(found.length, ACCOUNT_TRANSFERS_PAGE);
    while (end > 0 && end < found.length && found[end].height === found[end - 1].height) end += 1;
    const transfers = found.slice(0, end);
    const last = transfers.at(-1);
    const more = found.length > transfers.length || hi > 0;
    return { transfers, next: more && last ? last.height : null };
  };
  try {
    // The first page is what every visit opens; older pages are each read once.
    return before === undefined
      ? await cached(`gno-acct-transfers:${chain.chainId}:${address}`, 60_000, load, {
          staleMs: 10 * 60_000,
          group: { name: "gno-acct-transfers", max: 200 },
        })
      : await load();
  } catch {
    return null;
  }
}
