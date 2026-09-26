import { cached } from "@/lib/cache";
import { poolFor } from "@/lib/indexer-db";

/**
 * What the index can answer, per capability, and whether it is keeping up.
 *
 * The indexer's contract (docs/INDEXER.md, "Contract with Scan (extract
 * version 4)") says a reader never compares extract versions itself: it asks
 * `indexer_coverage(chain, capability)` for the contiguous run of blocks,
 * ending at the newest, in which every block carries that capability. No row
 * means not covered, so the caller uses the live path.
 *
 * Every read here fails soft. Before the version-4 migrations are deployed the
 * function does not exist; with no database configured there is no pool. Both
 * come back as "not covered", which every caller already treats as "use the
 * node", so this file can ship ahead of the indexer.
 */

export type Capability =
  | "blocks"
  | "fees"
  | "votes"
  | "slashing"
  | "missed_signatures"
  | "transfers"
  | "tx_meta"
  | "tx_party"
  | "tx_msg"
  | "ibc_packet"
  | "staking_event"
  | "validator_power"
  | "gov_deposit"
  | "gov_proposal"
  | "vote_event"
  | "tombstones_unjails";

export interface CoverageRange {
  lo: number;
  hi: number;
  loTime: string | null;
  hiTime: string | null;
}

/** The covered height range for a capability, or null when not covered. */
export async function coverageOf(
  chainId: string,
  capability: Capability
): Promise<CoverageRange | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  return cached(`idx:cov4:${chainId}:${capability}`, 30_000, async () => {
    const res = await pool.query<{
      lo: string;
      hi: string;
      lo_time: string | null;
      hi_time: string | null;
    }>(
      `SELECT lo::text, hi::text, lo_time::text, hi_time::text
         FROM indexer_coverage($1, $2)`,
      [chainId, capability]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      lo: Number(row.lo),
      hi: Number(row.hi),
      loTime: row.lo_time,
      hiTime: row.hi_time,
    };
  }).catch(() => null);
}

/** Whether a height falls inside a capability's covered range. */
export function inRange(range: CoverageRange | null, height: number): boolean {
  return range !== null && height >= range.lo && height <= range.hi;
}

export interface IndexerHealth {
  /** No committed batch or heartbeat for longer than the contract's 2 minutes. */
  stale: boolean;
  /** Blocks the follower is behind the node's head, when the indexer reports it. */
  lag: number | null;
  updatedAt: string | null;
}

const STALE_MS = 120_000;

/**
 * The follower's liveness. `updated_at` moves on every batch and on a heartbeat
 * at the head, so more than two minutes without it means stuck; `head_height`
 * minus `last_height` is how far behind a live follower is. `head_height` only
 * exists from version 4, so the read falls back to the older columns.
 */
export async function indexerHealth(chainId: string): Promise<IndexerHealth | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  return cached(`idx:health:${chainId}`, 10_000, async () => {
    type Row = { updated_at: string | null; last_height: string | null; head_height?: string | null };
    let row: Row | undefined;
    try {
      const res = await pool.query<Row>(
        `SELECT updated_at::text, last_height::text, head_height::text
           FROM indexer_cursor WHERE chain_id = $1`,
        [chainId]
      );
      row = res.rows[0];
    } catch {
      const res = await pool.query<Row>(
        `SELECT updated_at::text, last_height::text FROM indexer_cursor WHERE chain_id = $1`,
        [chainId]
      );
      row = res.rows[0];
    }
    if (!row) return null;
    const updatedAt = row.updated_at;
    const age = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;
    const lag =
      row.head_height && row.last_height
        ? Math.max(0, Number(row.head_height) - Number(row.last_height))
        : null;
    return { stale: age > STALE_MS, lag, updatedAt };
  }).catch(() => null);
}
