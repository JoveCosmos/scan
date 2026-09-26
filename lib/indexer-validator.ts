import { cached } from "@/lib/cache";
import { coverage, poolFor } from "@/lib/indexer-db";

/**
 * Indexed reads for one validator's page, the overview and relayers.
 *
 * Every function returns null when the index cannot answer — no pool, no
 * coverage, a failed query — and the page shows N/A rather than a zero it
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
  const c = await coverage(chainId);
  if (!c) return null;

  try {
    return await cached(`idx:proposedlist:${chainId}:${proposerHex}`, 60_000, async () => {
      const { rows } = await pool.query<{ height: string; time: string; tx_count: number }>(
        `SELECT height::text, time::text, tx_count
           FROM block
          WHERE chain_id = $1 AND proposer_cons = $2
            AND height BETWEEN $3 AND $4
          ORDER BY height DESC
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
          GROUP BY height
          ORDER BY height`,
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
  /** Proposals with recorded votes since `since` — the fair denominator. */
  total: number;
  /** Voted on, among those `total`. */
  voted: number;
  since: string;
}

/**
 * Every vote an account cast, with its transaction, and the proposals it
 * skipped. The denominator counts only proposals voted on after `since` — the
 * validator's creation where the index holds it — so a validator is never
 * marked absent from a proposal that closed before it existed.
 */
export async function validatorVotes(
  chainId: string,
  account: string,
  since: string | null
): Promise<ValidatorVotes | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;
  const c = await coverage(chainId);
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
            ORDER BY proposal_id DESC`,
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
          ORDER BY height DESC
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
  const c = await coverage(chainId);
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
