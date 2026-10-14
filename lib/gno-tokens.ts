import type { ChainConfig } from "@/lib/chains";
import { gnoHashToHex, gql } from "@/lib/gno";
import { gnoTxTimes } from "@/lib/gno-packages";

/**
 * GRC20 tokens on gno.land, from the events of gno.land/p/nt/grc20/v0, the
 * package every token is built on: NewToken (key, name, symbol, decimals),
 * Transfer (token, from, to, value; a mint has an empty from, a burn an empty
 * to) and Approval.
 *
 * The tx-indexer returns at most 10,000 transactions a query and has no
 * paging, so history is read in height windows (halved when one comes back
 * full) from genesis to its head, then followed from where the last read
 * stopped. Balances are each address's transfers in minus out, so they are
 * exact as long as every event since genesis is read; supply is mints minus
 * burns.
 */

const GRC20 = "gno.land/p/nt/grc20/v0";
/** Transfers kept per token for its list, newest first. */
const RECENT = 300;
/** Refresh at most this often; a read in between gets the last state. */
const FRESH_MS = 60_000;

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

interface ChainTokens {
  /** Every height up to and including this one has been read; -1 before any. */
  height: number;
  tokens: Map<string, GnoToken>;
  syncing: Promise<void> | null;
  checkedAt: number;
}

const STATE_KEY = Symbol.for("gata.gnoTokens");
const states: Map<string, ChainTokens> =
  ((globalThis as Record<symbol, unknown>)[STATE_KEY] as Map<string, ChainTokens>) ??
  ((globalThis as Record<symbol, unknown>)[STATE_KEY] = new Map());

export type EventTx = {
  hash: string;
  block_height: number;
  response: { events: { type?: string; pkg_path?: string; attrs?: { key: string; value: string }[] | null }[] | null } | null;
};

/**
 * Transactions with grc20 events in a height range. The indexer has no
 * "greater or equal" and answers a negative bound with nothing, so the first
 * window, which must include genesis (height 0), has only its upper bound.
 */
const query = (first: boolean) => `query(${first ? "" : "$a: Int!, "}$b: Int!) {
  getTransactions(where: { success: { eq: true }, block_height: { ${first ? "" : "gt: $a, "}lt: $b },
    response: { events: { GnoEvent: { pkg_path: { eq: "${GRC20}" } } } } }, order: { heightAndIndex: ASC }) {
    hash block_height
    response { events { ... on GnoEvent { type pkg_path attrs { key value } } } }
  }
}`;
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
export function applyGrc20(state: Pick<ChainTokens, "tokens">, txs: EventTx[]) {
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

/** Read every height after the last one read, up to the indexer's head. */
async function sync(chain: ChainConfig, state: ChainTokens): Promise<void> {
  const { latestBlockHeight: head } = await gql<{ latestBlockHeight: number }>(chain, "{ latestBlockHeight }");
  let window = 200_000;
  while (state.height < head) {
    const from = state.height;
    const to = Math.min(head, from + window);
    const data = await gql<{ getTransactions: EventTx[] | null }>(chain,
      query(from < 0),
      from < 0 ? { b: to + 1 } : { a: from, b: to + 1 },
      30_000
    );
    const txs = data.getTransactions ?? [];
    // A full answer may have been cut at the cap: read the window in halves.
    if (txs.length >= 10_000 && to > from + 1) {
      window = Math.max(1, Math.floor((to - from) / 2));
      continue;
    }
    applyGrc20(state, txs);
    state.height = to;
    window = Math.min(window * 2, 200_000);
  }
}

/**
 * Every token on the chain with its holders and recent transfers, brought up
 * to the indexer's head at most once a minute. The first read of a chain waits
 * for its whole history (seconds); later ones get the last state at once while
 * a refresh runs behind them.
 */
export async function gnoTokens(chain: ChainConfig): Promise<Map<string, GnoToken> | null> {
  if (chain.kind !== "gno" || chain.indexerEndpoints.length === 0) return null;
  let state = states.get(chain.chainId);
  if (!state) {
    state = { height: -1, tokens: new Map(), syncing: null, checkedAt: 0 };
    states.set(chain.chainId, state);
  }
  const s = state;
  if (!s.syncing && Date.now() - s.checkedAt > FRESH_MS) {
    s.syncing = sync(chain, s)
      .then(() => {
        s.checkedAt = Date.now();
      })
      .catch((err) => {
        // Keep what was read; the next read retries from there.
        s.checkedAt = Date.now() - FRESH_MS / 2;
        console.warn(`[tokens] ${chain.chainId}:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        s.syncing = null;
      });
  }
  if (s.height < 0 || s.tokens.size === 0) {
    await s.syncing;
    if (s.height < 0) return null;
  }
  return s.tokens;
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
