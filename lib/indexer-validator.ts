import { cached } from "@/lib/cache";
import { coverage, poolFor } from "@/lib/indexer-db";
import {
  coverageOf,
  indexerHealth,
  type CoverageRange,
  type IndexerHealth,
} from "@/lib/indexer-coverage";
import {
  dailySeries,
  earlierVotes,
  longestRun,
  netStakeFlow,
  reliability,
  type CastVote,
  type MissRun,
  type StakeEventLike,
} from "@/lib/signing-stats";

/**
 * Indexed reads for one validator's page, the overview and relayers.
 *
 * Every function returns null when the index cannot answer - no pool, no
 * coverage, a failed query - and the page shows N/A rather than a zero it
 * cannot vouch for. Same contract as lib/indexer-db.ts.
 */

// ── Proposed blocks ─────────────────────────────────────────────────────────

export interface ProposedBlock {
  height: number;
  time: string;
  txCount: number;
}

export interface ProposedBlocks {
  blocks: ProposedBlock[];
  since: string;
  fromGenesis: boolean;
}

/** The newest blocks a validator proposed, within the indexed window. */
export async function proposedBlocks(
  chainId: string,
  proposerHex: string,
  limit = 200
): Promise<ProposedBlocks | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const c = await coverage(chainId, "blocks");
  if (!c) return null;

  try {
    return await cached(`idx:proposedlist:${chainId}:${proposerHex}`, 60_000, async () => {
      const { rows } = await pool.query<{ height: string; time: string; tx_count: number }>(
        `SELECT height::text, time::text, tx_count
           FROM block
          WHERE chain_id = $1 AND proposer_cons = $2
            AND height BETWEEN $3 AND $4
          ORDER BY block.height DESC
          LIMIT $5`,
        [chainId, proposerHex, c.lowest, c.highest, limit]
      );
      return {
        blocks: rows.map((r) => ({
          height: Number(r.height),
          time: r.time,
          txCount: Number(r.tx_count ?? 0),
        })),
        since: c.from,
        fromGenesis: c.lowest <= 1,
      };
    });
  } catch {
    return null;
  }
}

// ── Proposer fairness ───────────────────────────────────────────────────────

export interface StakeSample {
  /** Snapshot height. */
  height: number;
  /** Bonded tokens of the whole set at that snapshot. */
  total: number;
  /** This validator's bonded tokens at that snapshot; 0 when absent. */
  mine: number;
}

/**
 * Blocks a validator should have proposed, from its stake over its own active
 * time. Each snapshot's share holds until the next snapshot, so the interval
 * contributes share × blocks-in-interval. The window runs from the first
 * snapshot where the validator held stake to the end of the last such
 * interval: a validator that joined halfway is measured over its own half, not
 * against blocks produced before it existed.
 *
 * Proposer selection is weighted by voting power, so over a long window the
 * proposed count should track this closely.
 */
export function expectedProposals(
  samples: StakeSample[]
): { from: number; to: number; expected: number } | null {
  const sorted = [...samples].sort((a, b) => a.height - b.height);
  let from: number | null = null;
  let to: number | null = null;
  let expected = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const next = sorted[i + 1];
    const blocks = next.height - s.height;
    if (blocks <= 0 || s.total <= 0 || s.mine <= 0) continue;
    if (from === null) from = s.height;
    to = next.height;
    expected += (s.mine / s.total) * blocks;
  }

  if (from === null || to === null || expected <= 0) return null;
  return { from, to, expected };
}

export interface ProposerFairness {
  proposed: number;
  expected: number;
  /** proposed ÷ expected. */
  ratio: number;
  fromHeight: number;
  toHeight: number;
}

/**
 * Blocks proposed against blocks owed by stake, over the validator's own
 * active window within the stake snapshots. Null until there are at least two
 * snapshots with this validator in them.
 */
export async function proposerFairness(
  chainId: string,
  operator: string,
  proposerHex: string
): Promise<ProposerFairness | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  try {
    return await cached(`idx:fairness:${chainId}:${operator}`, 10 * 60_000, async () => {
      const { rows } = await pool.query<{ height: string; total: string; mine: string | null }>(
        `SELECT height::text,
                sum(tokens)::text AS total,
                sum(tokens) FILTER (WHERE operator = $2)::text AS mine
           FROM validator_stake
          WHERE chain_id = $1
          GROUP BY validator_stake.height
          ORDER BY validator_stake.height`,
        [chainId, operator]
      );
      const window = expectedProposals(
        rows.map((r) => ({
          height: Number(r.height),
          total: Number(r.total),
          mine: Number(r.mine ?? 0),
        }))
      );
      if (!window) return null;

      const counted = await pool.query<{ n: string; indexed: string }>(
        `SELECT count(*) FILTER (WHERE proposer_cons = $2)::text AS n,
                count(*)::text AS indexed
           FROM block
          WHERE chain_id = $1 AND height >= $3 AND height < $4`,
        [chainId, proposerHex, window.from, window.to]
      );
      const proposed = Number(counted.rows[0]?.n ?? 0);
      const indexed = Number(counted.rows[0]?.indexed ?? 0);
      // Only trust the window if the index actually holds its blocks.
      if (indexed < (window.to - window.from) * 0.95) return null;

      return {
        proposed,
        expected: window.expected,
        ratio: proposed / window.expected,
        fromHeight: window.from,
        toHeight: window.to,
      };
    });
  } catch {
    return null;
  }
}

// ── Validator events ────────────────────────────────────────────────────────

export type ValidatorEventKind = "create" | "edit" | "unjail" | "commission";

export interface ValidatorEvent {
  kind: ValidatorEventKind;
  txHash: string;
  height: number;
  time: string;
  ok: boolean;
  /** Commission withdrawn, per denom; empty for other kinds. */
  amounts: { denom: string; amount: string }[];
}

const EVENT_SUFFIX: [string, ValidatorEventKind][] = [
  [".MsgCreateValidator", "create"],
  [".MsgEditValidator", "edit"],
  [".MsgUnjail", "unjail"],
  [".MsgWithdrawValidatorCommission", "commission"],
];

/** The event kind of a transaction's message types, most specific first. */
export function eventKind(msgTypes: string[]): ValidatorEventKind | null {
  for (const [suffix, kind] of EVENT_SUFFIX) {
    if (msgTypes.some((t) => t.endsWith(suffix))) return kind;
  }
  return null;
}

/**
 * Transactions the operator signed that change or maintain the validator:
 * creation, edits, unjails and commission withdrawals, newest first. Only the
 * operator's own account can sign these, which is what ties them to it.
 */
export async function validatorEvents(
  chainId: string,
  account: string,
  limit = 300
): Promise<ValidatorEvent[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  try {
    return await cached(`idx:valevents:${chainId}:${account}`, 5 * 60_000, async () => {
      const { rows } = await pool.query<{
        hash: string;
        height: string;
        time: string;
        code: number | null;
        msg_types: string[] | null;
        amounts: { denom: string; amount: string }[] | null;
      }>(
        `SELECT t.hash, t.height::text, t.time::text, t.code, t.msg_types, c.amounts
           FROM tx t
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object('denom', tr.denom, 'amount', tr.amount::text)) AS amounts
               FROM transfer tr
              WHERE tr.chain_id = t.chain_id AND tr.tx_hash = t.hash AND tr.kind = 'commission'
           ) c ON true
          WHERE t.chain_id = $1 AND t.signer = $2
            AND EXISTS (
              SELECT 1 FROM unnest(t.msg_types) m WHERE m LIKE ANY($3::text[])
            )
          ORDER BY t.height DESC
          LIMIT $4`,
        [chainId, account, EVENT_SUFFIX.map(([s]) => `%${s}`), limit]
      );
      return rows.flatMap((r) => {
        const kind = eventKind(r.msg_types ?? []);
        if (!kind) return [];
        return [
          {
            kind,
            txHash: r.hash,
            height: Number(r.height),
            time: r.time,
            ok: (r.code ?? 0) === 0,
            amounts: r.amounts ?? [],
          },
        ];
      });
    });
  } catch {
    return null;
  }
}

// ── Governance ──────────────────────────────────────────────────────────────

export interface ValidatorVote {
  proposalId: number;
  option: string;
  weighted: boolean;
  height: number;
  time: string;
  txHash: string;
}

export interface ValidatorVotes {
  votes: ValidatorVote[];
  /** Proposals voted on since `since` that this account skipped, newest first. */
  skipped: number[];
  /** Proposals with recorded votes since `since` - the fair denominator. */
  total: number;
  /** Voted on, among those `total`. */
  voted: number;
  since: string;
}

/**
 * Every vote an account cast, with its transaction, and the proposals it
 * skipped. The denominator counts only proposals voted on after `since` - the
 * validator's creation where the index holds it - so a validator is never
 * marked absent from a proposal that closed before it existed.
 */
export async function validatorVotes(
  chainId: string,
  account: string,
  since: string | null
): Promise<ValidatorVotes | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const c = await coverage(chainId, "votes");
  if (!c) return null;
  const from = since && Date.parse(since) > Date.parse(c.from) ? since : c.from;

  try {
    return await cached(`idx:valvotes:${chainId}:${account}:${from}`, 5 * 60_000, async () => {
      const [mine, skipped, total] = await Promise.all([
        pool.query<{
          proposal_id: string;
          option: string;
          weighted: boolean;
          height: string;
          time: string;
          tx_hash: string;
        }>(
          `SELECT proposal_id::text, option, weighted, height::text, time::text, tx_hash
             FROM vote WHERE chain_id = $1 AND voter = $2
            ORDER BY vote.proposal_id DESC`,
          [chainId, account]
        ),
        pool.query<{ proposal_id: string }>(
          `SELECT DISTINCT proposal_id::text FROM vote v
            WHERE v.chain_id = $1 AND v.time >= $3
              AND NOT EXISTS (
                SELECT 1 FROM vote m
                 WHERE m.chain_id = $1 AND m.proposal_id = v.proposal_id AND m.voter = $2
              )
            ORDER BY 1 DESC`,
          [chainId, account, from]
        ),
        pool.query<{ n: string }>(
          `SELECT count(DISTINCT proposal_id)::text AS n FROM vote
            WHERE chain_id = $1 AND time >= $2`,
          [chainId, from]
        ),
      ]);
      const skippedIds = skipped.rows
        .map((r) => Number(r.proposal_id))
        .sort((a, b) => b - a);
      const totalN = Number(total.rows[0]?.n ?? 0);
      return {
        votes: mine.rows.map((r) => ({
          proposalId: Number(r.proposal_id),
          option: r.option,
          weighted: r.weighted,
          height: Number(r.height),
          time: r.time,
          txHash: r.tx_hash,
        })),
        skipped: skippedIds,
        total: totalN,
        voted: Math.max(0, totalN - skippedIds.length),
        since: from,
      };
    });
  } catch {
    return null;
  }
}

// ── Overview: recent jailings ───────────────────────────────────────────────

export interface RecentJailing {
  height: number;
  time: string;
  consAddr: string;
  kind: "jailed" | "tombstoned";
  reason: string | null;
}

export async function recentJailings(
  chainId: string,
  limit = 10
): Promise<RecentJailing[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  try {
    return await cached(`idx:recentjail:${chainId}`, 60_000, async () => {
      const { rows } = await pool.query<{
        height: string;
        time: string;
        cons_addr: string;
        kind: "jailed" | "tombstoned";
        reason: string | null;
      }>(
        `SELECT height::text, time::text, cons_addr, kind, reason
           FROM slash_event
          WHERE chain_id = $1 AND kind IN ('jailed', 'tombstoned')
          ORDER BY slash_event.height DESC
          LIMIT $2`,
        [chainId, limit]
      );
      return rows.map((r) => ({
        height: Number(r.height),
        time: r.time,
        consAddr: r.cons_addr,
        kind: r.kind,
        reason: r.reason,
      }));
    });
  } catch {
    return null;
  }
}

// ── Relayers: packets, not transactions ─────────────────────────────────────

/**
 * Packet messages delivered per relayer (receive, acknowledgement, timeout),
 * keyed by fee payer. One relay transaction usually batches several packets
 * plus a client update, so counting transactions understates the work.
 */
export async function relayerPackets(
  chainId: string,
  packetTypes: string[]
): Promise<Map<string, number> | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const c = await coverage(chainId, "fees");
  if (!c) return null;

  try {
    return await cached(`idx:relaypackets:${chainId}`, 5 * 60_000, async () => {
      const { rows } = await pool.query<{ signer: string; packets: string }>(
        `SELECT signer,
                sum((SELECT count(*) FROM unnest(msg_types) m WHERE m = ANY($2::text[])))::text AS packets
           FROM tx
          WHERE chain_id = $1 AND signer IS NOT NULL
            AND msg_types && $2::text[]
            AND height BETWEEN $3 AND $4
          GROUP BY signer`,
        [chainId, packetTypes, c.lowest, c.highest]
      );
      return new Map(rows.map((r) => [r.signer, Number(r.packets)]));
    });
  } catch {
    return null;
  }
}

// ── Version-4 and version-3 reads ───────────────────────────────────────────
//
// Each gates on a capability through indexer_coverage (lib/indexer-coverage).
// Before the version-4 deploy that function does not exist; the one capability
// production already serves, missed signatures (version 3), falls back to the
// equivalent block-version check so signing history ships ahead of it.

export type { IndexerHealth };

/** Whether the follower has stopped; indexed views mark themselves behind. */
export async function indexBehind(chainId: string): Promise<boolean> {
  const h = await indexerHealth(chainId).catch(() => null);
  return h?.stale === true;
}

export const SQL = {
  /** Contiguous run of version-3+ blocks ending at the newest. */
  v3Coverage: `
    SELECT (COALESCE(
              (SELECT max(height) FROM block WHERE chain_id = $1 AND extract_version < 3),
              (SELECT min(height) - 1 FROM block WHERE chain_id = $1)
            ) + 1)::text AS lo,
           (SELECT max(height) FROM block WHERE chain_id = $1)::text AS hi`,
  blockTimes: `SELECT height::text, time::text FROM block WHERE chain_id = $1 AND height = ANY($2::bigint[])`,
  // First block by time rather than min(height) over the range: the time index
  // answers this in one row, where min(height) read every block since then
  // (1.3 million for 90 days on AtomOne) and held the Signing tab ~35 s.
  firstHeightSince: `SELECT height::text AS h FROM block WHERE chain_id = $1 AND time >= $2 ORDER BY time ASC LIMIT 1`,
  consHexByOperator: `SELECT cons_hex FROM validator_key WHERE chain_id = $1 AND operator = $2`,
  operatorsByHex: `SELECT cons_hex, operator FROM validator_key WHERE chain_id = $1 AND cons_hex = ANY($2::text[])`,
  missedCounts: `
    SELECT count(*) FILTER (WHERE flag = 'absent' AND height >= $3)::int AS d30,
           count(*) FILTER (WHERE flag = 'absent' AND height >= $4)::int AS d90,
           count(*) FILTER (WHERE flag = 'absent')::int AS total,
           count(*) FILTER (WHERE flag = 'nil')::int AS nil
      FROM missed_signature
     WHERE chain_id = $1 AND cons_addr = $2 AND height BETWEEN $5 AND $6`,
  missedDaily: `
    SELECT to_char(date_trunc('day', b.time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           count(*)::int AS missed
      FROM missed_signature m
      JOIN block b ON b.chain_id = m.chain_id AND b.height = m.height
     WHERE m.chain_id = $1 AND m.cons_addr = $2 AND m.flag = 'absent'
       AND m.height BETWEEN $3 AND $4
     GROUP BY 1 ORDER BY 1`,
  missedRuns: `
    WITH m AS (
      SELECT height FROM missed_signature
       WHERE chain_id = $1 AND cons_addr = $2 AND flag = 'absent'
         AND height BETWEEN $3 AND $4
    ), g AS (
      SELECT height, height - row_number() OVER (ORDER BY height) AS grp FROM m
    ), r AS (
      SELECT min(height) AS lo, max(height) AS hi, count(*)::int AS n FROM g GROUP BY grp
    )
    (SELECT lo::text, hi::text, n, 'recent' AS tag FROM r ORDER BY r.hi DESC LIMIT 20)
    UNION ALL
    (SELECT lo::text, hi::text, n, 'longest' AS tag FROM r ORDER BY n DESC, r.hi DESC LIMIT 1)`,
  missedBySet: `
    SELECT cons_addr, count(*)::int AS n
      FROM missed_signature
     WHERE chain_id = $1 AND flag = 'absent' AND height BETWEEN $2 AND $3
     GROUP BY cons_addr`,
  missedAt: `SELECT cons_addr, flag FROM missed_signature WHERE chain_id = $1 AND height = $2`,
  stakingEvents: `
    SELECT height::text, tx_hash, time::text, kind, validator, validator_dst, delegator,
           amount::text, denom, completion_time::text
      FROM staking_event
     WHERE chain_id = $1 AND (validator = $2 OR validator_dst = $2)
       AND height BETWEEN $3 AND $4
       AND kind NOT IN ('complete_unbonding', 'complete_redelegation')
     ORDER BY staking_event.height DESC, event_seq DESC
     LIMIT $5`,
  stakingFlowRows: `
    SELECT kind, validator, validator_dst, amount::text, time::text
      FROM staking_event
     WHERE chain_id = $1 AND (validator = $2 OR validator_dst = $2)
       AND height BETWEEN $3 AND $4 AND time >= $5
       AND kind IN ('delegate', 'undelegate', 'redelegate', 'cancel_unbonding', 'create_validator')`,
  powerHistory: `
    SELECT vp.height::text, vp.power::text, b.time::text
      FROM validator_power vp
      JOIN block b ON b.chain_id = vp.chain_id AND b.height = vp.height
     WHERE vp.chain_id = $1 AND vp.cons_addr = $2 AND vp.height BETWEEN $3 AND $4
     ORDER BY vp.height DESC
     LIMIT 2000`,
  powerBefore: `
    SELECT power::text FROM validator_power
     WHERE chain_id = $1 AND cons_addr = $2 AND height < $3
     ORDER BY height DESC LIMIT 1`,
  govProposal: `
    SELECT submit_height::text, submit_tx, submit_time::text, proposer, outcome,
           outcome_height::text, outcome_time::text
      FROM gov_proposal WHERE chain_id = $1 AND proposal_id = $2`,
  govDeposits: `
    SELECT depositor, coins, height::text, time::text, tx_hash
      FROM gov_deposit WHERE chain_id = $1 AND proposal_id = $2
     ORDER BY gov_deposit.height ASC, event_seq ASC`,
  voteEventsForProposal: `
    SELECT voter, option, height::text, time::text, tx_hash
      FROM vote_event WHERE chain_id = $1 AND proposal_id = $2
     ORDER BY vote_event.height ASC, event_seq ASC`,
  voteEventsForVoter: `
    SELECT proposal_id::text, option, height::text, time::text, tx_hash
      FROM vote_event WHERE chain_id = $1 AND voter = $2
     ORDER BY vote_event.height ASC, event_seq ASC`,
};

/**
 * Covered range for missed signatures: the capability when the indexer
 * reports it, otherwise the version-3 block run the follower has written.
 */
export async function signingCoverage(chainId: string): Promise<CoverageRange | null> {
  const cap = await coverageOf(chainId, "missed_signatures");
  if (cap) return cap;
  const pool = poolFor(chainId);
  if (!pool) return null;
  try {
    return await cached(`idx:v3cov:${chainId}`, 30_000, async () => {
      const { rows } = await pool.query<{ lo: string | null; hi: string | null }>(SQL.v3Coverage, [
        chainId,
      ]);
      const lo = Number(rows[0]?.lo);
      const hi = Number(rows[0]?.hi);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return null;
      const times = await pool.query<{ height: string; time: string }>(SQL.blockTimes, [
        chainId,
        [lo, hi],
      ]);
      const at = new Map(times.rows.map((r) => [Number(r.height), r.time]));
      return { lo, hi, loTime: at.get(lo) ?? null, hiTime: at.get(hi) ?? null };
    });
  } catch {
    return null;
  }
}

/** The consensus hex the index knows an operator by (validator_key, v4). */
export async function consHexOf(chainId: string, operator: string): Promise<string | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  try {
    const { rows } = await pool.query<{ cons_hex: string }>(SQL.consHexByOperator, [
      chainId,
      operator,
    ]);
    return rows[0]?.cons_hex ?? null;
  } catch {
    return null;
  }
}

/**
 * The first block of the last `days` days. The same for every validator on the
 * chain, so cached per chain; the cutoff is rounded to the hour so the key holds
 * still for that long.
 */
function heightDaysAgo(chainId: string, days: number): Promise<number | null> {
  const pool = poolFor(chainId);
  if (!pool) return Promise.resolve(null);
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const since = new Date(hour - days * DAY_MS).toISOString();
  return cached(`idx:heightsince:${chainId}:${days}:${hour}`, 60 * 60_000, async () => {
    const { rows } = await pool.query<{ h: string | null }>(SQL.firstHeightSince, [chainId, since]);
    const h = Number(rows[0]?.h);
    return rows[0]?.h && Number.isFinite(h) ? h : null;
  });
}

export interface SigningWindow {
  blocks: number;
  missed: number;
  ratio: number | null;
}

export interface SigningHistory {
  coverage: CoverageRange;
  /** Missed blocks per UTC day, last 90 days (or since coverage began). */
  daily: { day: string; missed: number }[];
  d30: SigningWindow | null;
  d90: SigningWindow | null;
  all: SigningWindow;
  /** Votes for nil: the validator was live but disagreed. Not downtime. */
  nil: number;
  longest: MissRun | null;
  /** Newest runs of consecutive misses. */
  recent: MissRun[];
}

const DAY_MS = 86_400_000;

/**
 * A validator's signing record over everything the index holds: misses per
 * day, reliability over 30 and 90 days and all of history, the longest run and
 * the recent ones. Denominators are blocks in the window; periods out of the
 * active set count as signed, since the index records only slots it was given.
 */
export async function signingHistory(
  chainId: string,
  consHex: string
): Promise<SigningHistory | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await signingCoverage(chainId);
  if (!cov) return null;
  const hex = consHex.toUpperCase();

  try {
    return await cached(
      `idx:signing:${chainId}:${hex}`,
      120_000,
      async () => {
        const now = Date.now();
        const [h30, h90] = await Promise.all([
          heightDaysAgo(chainId, 30),
          heightDaysAgo(chainId, 90),
        ]);
        const from30 = h30 !== null && h30 >= cov.lo ? h30 : null;
        const from90 = h90 !== null && h90 >= cov.lo ? h90 : null;
        const dailyFrom = Math.max(cov.lo, h90 ?? cov.lo);

        const [counts, daily, runs] = await Promise.all([
          pool.query<{ d30: number; d90: number; total: number; nil: number }>(SQL.missedCounts, [
            chainId,
            hex,
            from30 ?? cov.hi + 1,
            from90 ?? cov.hi + 1,
            cov.lo,
            cov.hi,
          ]),
          pool.query<{ day: string; missed: number }>(SQL.missedDaily, [
            chainId,
            hex,
            dailyFrom,
            cov.hi,
          ]),
          pool.query<{ lo: string; hi: string; n: number; tag: string }>(SQL.missedRuns, [
            chainId,
            hex,
            cov.lo,
            cov.hi,
          ]),
        ]);

        const c = counts.rows[0] ?? { d30: 0, d90: 0, total: 0, nil: 0 };
        const window = (from: number | null, missed: number): SigningWindow | null =>
          from === null
            ? null
            : { blocks: cov.hi - from + 1, missed, ratio: reliability(cov.hi - from + 1, missed) };

        const toRun = (r: { lo: string; hi: string; n: number }): MissRun => ({
          from: Number(r.lo),
          to: Number(r.hi),
          length: Number(r.n),
        });
        const recent = runs.rows.filter((r) => r.tag === "recent").map(toRun);
        const longestRow = runs.rows.find((r) => r.tag === "longest");
        const days = Math.max(
          1,
          Math.min(90, Math.ceil((now - Date.parse(cov.loTime ?? new Date(now).toISOString())) / DAY_MS))
        );

        return {
          coverage: cov,
          daily: dailySeries(
            daily.rows.map((r) => ({ day: r.day, missed: Number(r.missed) })),
            days
          ),
          d30: window(from30, Number(c.d30)),
          d90: window(from90, Number(c.d90)),
          all: {
            blocks: cov.hi - cov.lo + 1,
            missed: Number(c.total),
            ratio: reliability(cov.hi - cov.lo + 1, Number(c.total)),
          },
          nil: Number(c.nil),
          longest: longestRow ? toRun(longestRow) : longestRun(recent),
          recent,
        };
      },
      { staleMs: 600_000 }
    );
  } catch {
    return null;
  }
}

/**
 * Blocks each consensus key missed in the last 30 days, for the whole set in
 * one grouped read. Keys with no misses are absent (zero). Null when the index
 * does not cover the full 30 days.
 */
export async function missedLast30d(chainId: string): Promise<Map<string, number> | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await signingCoverage(chainId);
  if (!cov) return null;
  try {
    return await cached(
      `idx:missed30:${chainId}`,
      300_000,
      async () => {
        const from = await heightDaysAgo(chainId, 30);
        if (from === null || from < cov.lo) return null;
        const { rows } = await pool.query<{ cons_addr: string; n: number }>(SQL.missedBySet, [
          chainId,
          from,
          cov.hi,
        ]);
        return new Map(rows.map((r) => [r.cons_addr.toUpperCase(), Number(r.n)]));
      },
      { staleMs: 1_800_000 }
    );
  } catch {
    return null;
  }
}

/**
 * Consensus keys that did not sign a height (absent, not nil), from the index.
 * Null when the height is outside coverage.
 */
export async function absentAt(chainId: string, height: number): Promise<string[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await signingCoverage(chainId);
  if (!cov || height < cov.lo || height > cov.hi) return null;
  try {
    const { rows } = await pool.query<{ cons_addr: string; flag: string }>(SQL.missedAt, [
      chainId,
      height,
    ]);
    return rows.filter((r) => r.flag === "absent").map((r) => r.cons_addr.toUpperCase());
  } catch {
    return null;
  }
}

/** Operators for consensus keys, from validator_key (v4). Empty when absent. */
export async function operatorsForHex(
  chainId: string,
  hexes: string[]
): Promise<Map<string, string>> {
  const pool = poolFor(chainId);
  if (!pool || hexes.length === 0) return new Map();
  try {
    const { rows } = await pool.query<{ cons_hex: string; operator: string }>(SQL.operatorsByHex, [
      chainId,
      hexes.map((h) => h.toUpperCase()),
    ]);
    return new Map(rows.map((r) => [r.cons_hex.toUpperCase(), r.operator]));
  } catch {
    return new Map();
  }
}

// ── Power events ────────────────────────────────────────────────────────────

export interface PowerEvent extends StakeEventLike {
  height: number;
  txHash: string;
  delegator: string | null;
  denom: string | null;
  completionTime: string | null;
}

export interface PowerEvents {
  events: PowerEvent[];
  /** Net base units in over 7 and 30 days; null when coverage is shorter. */
  flow7: string | null;
  flow30: string | null;
  since: string | null;
}

/** Delegations, undelegations and redelegations into and out of a validator. */
export async function powerEvents(chainId: string, operator: string): Promise<PowerEvents | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await coverageOf(chainId, "staking_event");
  if (!cov) return null;
  try {
    return await cached(`idx:powerev:${chainId}:${operator}`, 60_000, async () => {
      const now = Date.now();
      const since30 = new Date(now - 30 * DAY_MS).toISOString();
      const [list, flowRows] = await Promise.all([
        pool.query<{
          height: string;
          tx_hash: string;
          time: string;
          kind: string;
          validator: string | null;
          validator_dst: string | null;
          delegator: string | null;
          amount: string | null;
          denom: string | null;
          completion_time: string | null;
        }>(SQL.stakingEvents, [chainId, operator, cov.lo, cov.hi, 200]),
        pool.query<{
          kind: string;
          validator: string | null;
          validator_dst: string | null;
          amount: string | null;
          time: string;
        }>(SQL.stakingFlowRows, [chainId, operator, cov.lo, cov.hi, since30]),
      ]);
      const flows = flowRows.rows.map((r) => ({
        kind: r.kind,
        validator: r.validator,
        validatorDst: r.validator_dst,
        amount: r.amount,
        time: r.time,
      }));
      const coveredFrom = cov.loTime ? Date.parse(cov.loTime) : Infinity;
      return {
        events: list.rows.map((r) => ({
          height: Number(r.height),
          txHash: r.tx_hash,
          time: r.time,
          kind: r.kind,
          validator: r.validator,
          validatorDst: r.validator_dst,
          delegator: r.delegator,
          amount: r.amount,
          denom: r.denom,
          completionTime: r.completion_time,
        })),
        flow7:
          coveredFrom <= now - 7 * DAY_MS
            ? netStakeFlow(flows, operator, now - 7 * DAY_MS).toString()
            : null,
        flow30:
          coveredFrom <= now - 30 * DAY_MS
            ? netStakeFlow(flows, operator, now - 30 * DAY_MS).toString()
            : null,
        since: cov.loTime,
      };
    });
  } catch {
    return null;
  }
}

// ── Voting power history ────────────────────────────────────────────────────

export interface PowerPoint {
  height: number;
  time: string;
  power: string;
}

/**
 * Every change to a validator's consensus power, oldest first, with the
 * power in force when coverage began as the first point.
 */
export async function powerHistory(chainId: string, consHex: string): Promise<PowerPoint[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await coverageOf(chainId, "validator_power");
  if (!cov) return null;
  const hex = consHex.toUpperCase();
  try {
    return await cached(`idx:powerhist:${chainId}:${hex}`, 300_000, async () => {
      const [{ rows }, before] = await Promise.all([
        pool.query<{ height: string; power: string; time: string }>(SQL.powerHistory, [
          chainId,
          hex,
          cov.lo,
          cov.hi,
        ]),
        pool.query<{ power: string }>(SQL.powerBefore, [chainId, hex, cov.lo]),
      ]);
      const points = rows
        .map((r) => ({ height: Number(r.height), time: r.time, power: r.power }))
        .reverse();
      const opening = before.rows[0]?.power;
      if (opening !== undefined && cov.loTime && (points[0]?.height ?? Infinity) > cov.lo) {
        points.unshift({ height: cov.lo, time: cov.loTime, power: opening });
      }
      return points;
    });
  } catch {
    return null;
  }
}

// ── Governance ──────────────────────────────────────────────────────────────

export interface GovProposalRecord {
  submitHeight: number | null;
  submitTx: string | null;
  submitTime: string | null;
  proposer: string | null;
  outcome: string | null;
  outcomeHeight: number | null;
  outcomeTime: string | null;
}

/** What the index recorded about a proposal's life: who, which tx, how it ended. */
export async function govProposalRecord(
  chainId: string,
  proposalId: string | number
): Promise<GovProposalRecord | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await coverageOf(chainId, "gov_proposal");
  if (!cov) return null;
  try {
    const { rows } = await pool.query<{
      submit_height: string | null;
      submit_tx: string | null;
      submit_time: string | null;
      proposer: string | null;
      outcome: string | null;
      outcome_height: string | null;
      outcome_time: string | null;
    }>(SQL.govProposal, [chainId, String(proposalId)]);
    const r = rows[0];
    if (!r) return null;
    return {
      submitHeight: r.submit_height ? Number(r.submit_height) : null,
      submitTx: r.submit_tx || null,
      submitTime: r.submit_time,
      proposer: r.proposer,
      outcome: r.outcome,
      outcomeHeight: r.outcome_height ? Number(r.outcome_height) : null,
      outcomeTime: r.outcome_time,
    };
  } catch {
    return null;
  }
}

export interface IndexedDeposit {
  depositor: string;
  /** Summed per denom across the depositor's deposits. */
  amount: { denom: string; amount: string }[];
}

/**
 * Every deposit on a proposal, summed per depositor. Only when coverage
 * reaches back past the proposal's submission, so no deposit is missing.
 */
export async function govDeposits(
  chainId: string,
  proposalId: string | number,
  submitTime: string | null
): Promise<IndexedDeposit[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await coverageOf(chainId, "gov_deposit");
  if (!cov || !cov.loTime || !submitTime) return null;
  if (Date.parse(submitTime) < Date.parse(cov.loTime)) return null;
  try {
    const { rows } = await pool.query<{
      depositor: string | null;
      coins: { denom: string; amount: string }[] | null;
    }>(SQL.govDeposits, [chainId, String(proposalId)]);
    return sumDeposits(rows);
  } catch {
    return null;
  }
}

export function sumDeposits(
  rows: readonly { depositor: string | null; coins: { denom: string; amount: string }[] | null }[]
): IndexedDeposit[] {
  const by = new Map<string, Map<string, bigint>>();
  for (const r of rows) {
    if (!r.depositor) continue;
    const coins = by.get(r.depositor) ?? new Map<string, bigint>();
    for (const c of r.coins ?? []) {
      try {
        coins.set(c.denom, (coins.get(c.denom) ?? BigInt(0)) + BigInt(c.amount));
      } catch {
        // A malformed amount is skipped rather than failing the list.
      }
    }
    by.set(r.depositor, coins);
  }
  return [...by.entries()].map(([depositor, coins]) => ({
    depositor,
    amount: [...coins.entries()].map(([denom, amount]) => ({ denom, amount: amount.toString() })),
  }));
}

/**
 * Earlier options of voters who changed their vote on a proposal, keyed by
 * voter. Only when coverage spans the whole voting period.
 */
export async function proposalRecasts(
  chainId: string,
  proposalId: string | number,
  votingStart: string | null
): Promise<Map<string, string[]> | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await coverageOf(chainId, "vote_event");
  if (!cov || !cov.loTime || !votingStart) return null;
  if (Date.parse(votingStart) < Date.parse(cov.loTime)) return null;
  try {
    return await cached(`idx:recasts:${chainId}:${proposalId}`, 60_000, async () => {
      const { rows } = await pool.query<{
        voter: string;
        option: string;
        height: string;
        time: string;
        tx_hash: string;
      }>(SQL.voteEventsForProposal, [chainId, String(proposalId)]);
      const casts: CastVote[] = rows.map((r) => ({
        voter: r.voter,
        proposalId: Number(proposalId),
        option: r.option,
        height: Number(r.height),
        time: r.time,
        txHash: r.tx_hash,
      }));
      const byKey = earlierVotes(casts);
      const out = new Map<string, string[]>();
      for (const [key, options] of byKey) out.set(key.slice(key.indexOf(":") + 1), options);
      return out;
    });
  } catch {
    return null;
  }
}

/** Earlier options of one voter, keyed by proposal id. */
export async function voterRecasts(
  chainId: string,
  voter: string
): Promise<Map<number, string[]> | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const cov = await coverageOf(chainId, "vote_event");
  if (!cov) return null;
  try {
    const { rows } = await pool.query<{
      proposal_id: string;
      option: string;
      height: string;
      time: string;
      tx_hash: string;
    }>(SQL.voteEventsForVoter, [chainId, voter]);
    const byKey = earlierVotes(
      rows.map((r) => ({
        voter,
        proposalId: Number(r.proposal_id),
        option: r.option,
        height: Number(r.height),
        time: r.time,
        txHash: r.tx_hash,
      }))
    );
    const out = new Map<number, string[]>();
    for (const [key, options] of byKey) out.set(Number(key.split(":")[0]), options);
    return out;
  } catch {
    return null;
  }
}
