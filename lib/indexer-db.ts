import { Pool } from "pg";
import { cached } from "@/lib/cache";

/**
 * The explorer's read-only view of the indexer's database.
 *
 * Every function here returns null when it cannot answer, and the caller falls
 * back to the live-node path it already had. That is the rule the whole
 * indexer rests on: reading from Postgres may be faster, but it must never make
 * a page worse than it was before the indexer existed.
 *
 * Unconfigured is a normal state. Without INDEXER_DATABASE_URL the explorer
 * behaves exactly as it did, which is what makes this safe to deploy before the
 * database is ready.
 */

const POOL_KEY = Symbol.for("gata.indexerPool");
const store = globalThis as typeof globalThis & {
  [POOL_KEY]?: Pool | null;
};

export function indexerPool(): Pool | null {
  if (store[POOL_KEY] !== undefined) return store[POOL_KEY];

  const url = process.env.INDEXER_DATABASE_URL;
  if (!url) {
    store[POOL_KEY] = null;
    return null;
  }

  store[POOL_KEY] = new Pool({
    connectionString: url,
    // Small: these are short indexed reads behind a request cache, and the
    // explorer must not be able to exhaust the indexer's connections.
    max: 4,
    connectionTimeoutMillis: 3000,
    application_name: "gata-explorer",
  });
  return store[POOL_KEY];
}

export interface Coverage {
  lowest: number;
  highest: number;
  /** Block times at the edges, for judging whether a period is covered. */
  from: string;
  to: string;
}

/**
 * The extractor whose output this file knows how to read.
 *
 * Must match EXTRACT_VERSION in the indexer. Blocks written below it are missing
 * rows this code expects to be there, so they are excluded from coverage.
 */
const READS_EXTRACT_VERSION = 2;

/**
 * Which slice of history the indexer actually holds for a chain.
 *
 * Backfill descends over days, so coverage is a moving window rather than
 * "everything". A caller must check this before trusting an answer, otherwise
 * a proposal from before the backfill reached it would render as having no
 * votes — worse than the slow path, because it would look like fact.
 *
 * The window stops below the first block written by an older extractor. Having
 * the block is not the same as having what was in it: AtomOne's follower wrote
 * a long run of blocks before votes were extracted at all, and counting those
 * as covered made proposal 21 report a fraction of its votes as its total.
 * Staleness like that accumulates at the top, so cutting at the lowest stale
 * height leaves a range that is genuinely complete rather than merely present.
 */
export async function coverage(chainId: string): Promise<Coverage | null> {
  const pool = indexerPool();
  if (!pool) return null;

  return cached(`idx:coverage:${chainId}`, 30_000, async () => {
    const res = await pool.query<{
      lowest: string | null;
      highest: string | null;
      starts: string | null;
      ends: string | null;
    }>(
      // "from" and "to" are reserved words and cannot be bare aliases.
      `WITH stale AS (
         SELECT COALESCE(
           (SELECT min(height) FROM block
             WHERE chain_id = $1 AND extract_version < $2),
           9223372036854775807
         ) AS floor
       )
       SELECT min(b.height)::text AS lowest, max(b.height)::text AS highest,
              min(b.time)::text   AS starts, max(b.time)::text   AS ends
         FROM block b, stale s
        WHERE b.chain_id = $1 AND b.height < s.floor`,
      [chainId, READS_EXTRACT_VERSION]
    );
    const r = res.rows[0];
    if (!r?.lowest || !r.highest || !r.starts || !r.ends) return null;
    return {
      lowest: Number(r.lowest),
      highest: Number(r.highest),
      from: r.starts,
      to: r.ends,
    };
  }).catch(() => null);
}

/**
 * Whether the indexer covers a period, with a margin at each end.
 *
 * The margin matters: a vote cast in the first block of the covered range is
 * only present by luck, and treating a partially covered proposal as complete
 * would under-report it silently.
 */
export function covers(
  c: Coverage | null,
  startIso: string | null,
  endIso: string | null
): boolean {
  if (!c || !startIso || !endIso) return false;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const from = Date.parse(c.from);
  const to = Date.parse(c.to);
  if (![start, end, from, to].every(Number.isFinite)) return false;

  const MARGIN_MS = 60 * 60 * 1000;
  return start >= from + MARGIN_MS && end <= to;
}

export type SlashKind = "slashed" | "jailed" | "unjailed" | "tombstoned";

export interface SlashEvent {
  height: number;
  time: string;
  kind: SlashKind;
  /** downtime | double_sign, when the chain said. */
  reason: string | null;
  /** Base-denom tokens burned; present on slash events only. */
  burned: string | null;
}

export interface SlashHistory {
  events: SlashEvent[];
  /** Start of the window these events were read from — never "all of history". */
  since: string;
}

/**
 * A validator's jailings, slashes and unjailings, most recent first.
 *
 * No node can answer this. The staking module keeps only the *current* jailed
 * flag and a jailed_until timestamp, so a validator jailed three times looks
 * exactly like one jailed once, and a validator that was jailed and recovered
 * looks like one that never was. The history exists solely in block events,
 * which is what makes it worth indexing.
 *
 * Keyed on the consensus address because that is the only identity slashing
 * events carry — they never mention the operator address.
 *
 * The result is bounded by coverage and says so. That is a weaker gate than the
 * one votes use, and deliberately: a partial vote list is a wrong tally stated
 * as fact, whereas a partial slash list is honest as long as the window it came
 * from is shown beside it. Refusing to render anything until the backfill
 * reaches genesis would withhold months of usable history for no gain.
 */
export async function slashHistory(
  chainId: string,
  consAddr: string
): Promise<SlashHistory | null> {
  const pool = indexerPool();
  if (!pool) return null;

  const c = await coverage(chainId);
  if (!c) return null;

  try {
    const res = await pool.query<{
      height: string;
      time: string;
      kind: SlashKind;
      reason: string | null;
      burned: string | null;
    }>(
      `SELECT height::text, time::text, kind, reason, burned::text
         FROM slash_event
        WHERE chain_id = $1 AND cons_addr = $2
          AND height BETWEEN $3 AND $4
        ORDER BY height DESC
        LIMIT 200`,
      [chainId, consAddr, c.lowest, c.highest]
    );

    return {
      events: res.rows.map((r) => ({
        height: Number(r.height),
        time: r.time,
        kind: r.kind,
        reason: r.reason,
        burned: r.burned,
      })),
      since: c.from,
    };
  } catch {
    return null;
  }
}

export interface IndexedVote {
  voter: string;
  option: string;
  weighted: boolean;
  options: { option: string; weight: string }[] | null;
}

/**
 * Every vote on a proposal, from the indexer.
 *
 * The reason this exists: reconstructing a tallied proposal from transaction
 * history costs tens of sequential paged tx-search requests — about thirty
 * seconds for AtomOne proposal 21 — because the gov module deletes votes once
 * it tallies them. Here it is one indexed read.
 *
 * Null means "cannot answer", never "no votes". An empty proposal returns an
 * empty array, which is a different and much stronger claim.
 */
export async function votesFromIndexer(
  chainId: string,
  proposalId: string
): Promise<IndexedVote[] | null> {
  const pool = indexerPool();
  if (!pool) return null;

  try {
    const res = await pool.query<{
      voter: string;
      option: string;
      weighted: boolean;
      options: { option: string; weight: string }[] | null;
    }>(
      `SELECT voter, option, weighted, options
         FROM vote
        WHERE chain_id = $1 AND proposal_id = $2`,
      [chainId, proposalId]
    );
    return res.rows;
  } catch {
    // A database that is down must look exactly like one that is unconfigured.
    return null;
  }
}
