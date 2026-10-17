import type { ChainConfig } from "@/lib/chains";
import { gql } from "@/lib/gno";

/**
 * State folded from every event one gno.land package has emitted, kept in
 * memory and brought up to the tx-indexer's head at most once a minute:
 * registered names (gno.land/r/sys/users), which our index does not hold.
 *
 * The tx-indexer returns at most 10,000 transactions a query and has no
 * paging, so history is read in height windows (halved when one comes back
 * full) from genesis, then followed from where the last read stopped. It has
 * no "greater or equal" and answers a negative bound with nothing, so the
 * first window, which must include genesis (height 0), has only its upper
 * bound.
 */

export type EventTx = {
  hash: string;
  block_height: number;
  response: { events: { type?: string; pkg_path?: string; attrs?: { key: string; value: string }[] | null }[] | null } | null;
};

interface Follower {
  /** Every height up to and including this one has been read; -1 before any. */
  height: number;
  state: unknown;
  syncing: Promise<void> | null;
  checkedAt: number;
}

const KEY = Symbol.for("gata.gnoFollowers");
const followers: Map<string, Follower> =
  ((globalThis as Record<symbol, unknown>)[KEY] as Map<string, Follower>) ??
  ((globalThis as Record<symbol, unknown>)[KEY] = new Map());

const CAP = 10_000;
const WINDOW = 200_000;
const FRESH_MS = 60_000;

const query = (pkgPath: string, first: boolean) => `query(${first ? "" : "$a: Int!, "}$b: Int!) {
  getTransactions(where: { success: { eq: true }, block_height: { ${first ? "" : "gt: $a, "}lt: $b },
    response: { events: { GnoEvent: { pkg_path: { eq: "${pkgPath}" } } } } }, order: { heightAndIndex: ASC }) {
    hash block_height
    response { events { ... on GnoEvent { type pkg_path attrs { key value } } } }
  }
}`;

async function sync(
  chain: ChainConfig,
  pkgPath: string,
  f: Follower,
  apply: (state: never, txs: EventTx[]) => void
): Promise<void> {
  const { latestBlockHeight: head } = await gql<{ latestBlockHeight: number }>(chain, "{ latestBlockHeight }");
  let window = WINDOW;
  while (f.height < head) {
    const from = f.height;
    const to = Math.min(head, from + window);
    const data = await gql<{ getTransactions: EventTx[] | null }>(
      chain,
      query(pkgPath, from < 0),
      from < 0 ? { b: to + 1 } : { a: from, b: to + 1 },
      30_000
    );
    const txs = data.getTransactions ?? [];
    // A full answer may have been cut at the cap: read the window in halves.
    if (txs.length >= CAP && to > from + 1) {
      window = Math.max(1, Math.floor((to - from) / 2));
      continue;
    }
    apply(f.state as never, txs);
    f.height = to;
    window = Math.min(window * 2, WINDOW);
  }
}

/**
 * The state `apply` has folded from `pkgPath`'s events on `chain`. The first
 * read of a chain waits for its whole history (seconds); later ones get the
 * last state at once while a refresh runs behind them. Null when the
 * tx-indexer cannot be read at all.
 */
export async function followEvents<S>(
  name: string,
  chain: ChainConfig,
  pkgPath: string,
  init: () => S,
  apply: (state: S, txs: EventTx[]) => void
): Promise<S | null> {
  if (chain.kind !== "gno" || chain.indexerEndpoints.length === 0) return null;
  const key = `${name}:${chain.chainId}`;
  let f = followers.get(key);
  if (!f) {
    f = { height: -1, state: init(), syncing: null, checkedAt: 0 };
    followers.set(key, f);
  }
  const follower = f;
  if (!follower.syncing && Date.now() - follower.checkedAt > FRESH_MS) {
    follower.syncing = sync(chain, pkgPath, follower, apply as (state: never, txs: EventTx[]) => void)
      .then(() => {
        follower.checkedAt = Date.now();
      })
      .catch((err) => {
        // Keep what was read; the next read retries from there.
        follower.checkedAt = Date.now() - FRESH_MS / 2;
        console.warn(`[${name}] ${chain.chainId}:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        follower.syncing = null;
      });
  }
  if (follower.height < 0) {
    await follower.syncing;
    if (follower.height < 0) return null;
  }
  return follower.state as S;
}
