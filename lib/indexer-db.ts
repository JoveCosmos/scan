import { Pool } from "pg";
import { cached } from "@/lib/cache";
import { getChain } from "@/lib/chains";

/**
 * Scan's read-only view of the indexer's database.
 *
 * Every function here returns null when it cannot answer, and the caller falls
 * back to the live-node path it already had. That is the rule the whole
 * indexer rests on: reading from Postgres may be faster, but it must never make
 * a page worse than it was before the indexer existed.
 *
 * Unconfigured is a normal state. Without INDEXER_DATABASE_URL Scan
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
    // scan must not be able to exhaust the indexer's connections.
    max: 4,
    connectionTimeoutMillis: 3000,
    application_name: "gata-scan",
  });
  return store[POOL_KEY];
}

/**
 * The pool, but only for chains the index actually holds.
 *
 * Gating here rather than at each of the ten call sites means marking a chain
 * unindexed stops every indexed read at once — including from code written
 * later that never considered it. Callers already handle a null pool by falling
 * back to the node, so this needs no handling of its own.
 *
 * An unknown chainId keeps the pool: the indexer holds chains the scan may not
 * have a config for, and refusing those would be a silent regression.
 */
function poolFor(chainId: string): Pool | null {
  const chain = getChain(chainId);
  if (chain && !chain.indexed) return null;
  return indexerPool();
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
  const pool = poolFor(chainId);
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
  /** Start of the window these events were read from. */
  since: string;
  /** True when that window starts at the first block — see ProposerStats. */
  fromGenesis: boolean;
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
  const pool = poolFor(chainId);
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
      fromGenesis: c.lowest <= 1,
    };
  } catch {
    return null;
  }
}

export interface JailCounts {
  /** Times jailed, keyed by consensus address. Absent means zero. */
  byConsAddr: Map<string, number>;
  /** Consensus addresses that have been tombstoned. */
  tombstoned: Set<string>;
  /** Start of the window these counts were taken from. */
  since: string;
  /** True when that window is the whole chain — see ProposerStats. */
  fromGenesis: boolean;
}

/**
 * How many times each validator has been jailed, for the whole set at once.
 *
 * The validator list needs one number per row, and asking per validator would
 * be one query per row. This is a single grouped read instead.
 *
 * Same reason as slashHistory for existing at all: the chain reports a current
 * jailed flag and a jailed_until date, so a validator jailed three times is
 * indistinguishable from one jailed once, and the list could only ever show
 * "when", never "how often".
 */
export async function jailCounts(chainId: string): Promise<JailCounts | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  const c = await coverage(chainId);
  if (!c) return null;

  return cached(`idx:jailcounts:${chainId}`, 60_000, async () => {
    const res = await pool.query<{
      cons_addr: string;
      jailings: string;
      tombstoned: boolean;
    }>(
      `SELECT cons_addr,
              count(*) FILTER (WHERE kind = 'jailed')::text AS jailings,
              bool_or(kind = 'tombstoned')                  AS tombstoned
         FROM slash_event
        WHERE chain_id = $1 AND height BETWEEN $2 AND $3
        GROUP BY cons_addr`,
      [chainId, c.lowest, c.highest]
    );

    const byConsAddr = new Map<string, number>();
    const tombstoned = new Set<string>();
    for (const r of res.rows) {
      const n = Number(r.jailings);
      if (n > 0) byConsAddr.set(r.cons_addr, n);
      if (r.tombstoned) tombstoned.add(r.cons_addr);
    }
    return { byConsAddr, tombstoned, since: c.from, fromGenesis: c.lowest <= 1 };
  }).catch(() => null);
}

export interface ProposerStats {
  /** Blocks this validator proposed within the indexed window. */
  proposed: number;
  /** Blocks indexed in that window, from every proposer. */
  totalBlocks: number;
  lastHeight: number | null;
  lastTime: string | null;
  since: string;
  /**
   * True when the indexed window reaches the first block, so "since <date>" is
   * just the chain's own start and not a limit worth stating. Backfill made
   * this a moving window; once it lands on genesis the caveat is noise.
   */
  fromGenesis: boolean;
}

/**
 * How much of the chain's block production a validator actually did.
 *
 * Proposer selection is weighted by voting power, so the share of blocks a
 * validator proposed should track its share of stake over any long window.
 * A share well below its power is the visible symptom of a validator that is
 * bonded but frequently missing its turn — something the signing percentage
 * alone does not distinguish from healthy operation, since a validator can sign
 * other proposers' blocks reliably while failing to produce its own.
 *
 * Two queries on purpose. The per-validator count is an index range scan over
 * that validator's rows; the chain-wide total would be a full scan, so it is
 * cached once and shared across every validator rather than repeated per page.
 */
export async function proposerStats(
  chainId: string,
  proposerCons: string
): Promise<ProposerStats | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  const c = await coverage(chainId);
  if (!c) return null;

  try {
    const [mine, total] = await Promise.all([
      cached(`idx:proposed:${chainId}:${proposerCons}`, 60_000, async () => {
        const res = await pool.query<{
          proposed: string;
          last_height: string | null;
          last_time: string | null;
        }>(
          `SELECT count(*)::text  AS proposed,
                  max(height)::text AS last_height,
                  max(time)::text   AS last_time
             FROM block
            WHERE chain_id = $1 AND proposer_cons = $2
              AND height BETWEEN $3 AND $4`,
          [chainId, proposerCons, c.lowest, c.highest]
        );
        return res.rows[0];
      }),
      blockCount(chainId, c.lowest, c.highest),
    ]);

    if (!mine || total === null) return null;

    return {
      proposed: Number(mine.proposed),
      totalBlocks: total,
      fromGenesis: c.lowest <= 1,
      lastHeight: mine.last_height ? Number(mine.last_height) : null,
      lastTime: mine.last_time,
      since: c.from,
    };
  } catch {
    return null;
  }
}

/**
 * Blocks indexed in a range. Cached hard: it is a full scan, and it is the same
 * answer for every validator on the chain.
 */
function blockCount(
  chainId: string,
  lowest: number,
  highest: number
): Promise<number | null> {
  const pool = poolFor(chainId);
  if (!pool) return Promise.resolve(null);

  return cached(`idx:blockcount:${chainId}:${lowest}:${highest}`, 300_000, async () => {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM block
        WHERE chain_id = $1 AND height BETWEEN $2 AND $3`,
      [chainId, lowest, highest]
    );
    return Number(res.rows[0]?.n ?? 0);
  }).catch(() => null);
}

export interface RelayerOperator {
  /** Fee payer of the relay transactions — the operator's own address. */
  address: string;
  /** Relay transactions signed within the indexed window. */
  txCount: number;
  /** Fees paid to relay, in base denom. What running a relayer costs. */
  feesPaid: string;
  lastHeight: number;
  lastTime: string;
}

export interface RelayerStats {
  operators: RelayerOperator[];
  totalTxs: number;
  since: string;
  /** True when the count covers the whole chain — see ProposerStats. */
  fromGenesis: boolean;
}

/**
 * Who is actually relaying on this chain, and how much of the work they do.
 *
 * Not answerable from a node. Relaying leaves no module state — a delivered
 * packet updates balances and clears a commitment, and nothing anywhere records
 * that a particular operator delivered it. The only durable trace is the
 * transaction itself, and the chain forgets those beyond its pruning window.
 *
 * Attributed by fee payer rather than by any relayer registry, because there is
 * no registry: whoever paid the gas did the work.
 *
 * MsgTransfer is deliberately not counted as relaying. Its signer is a user
 * moving their own funds, and including it would rank ordinary traffic as
 * infrastructure.
 */
export async function relayerStats(
  chainId: string,
  msgTypes: string[],
  limit = 50
): Promise<RelayerStats | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  const c = await coverage(chainId);
  if (!c) return null;

  return cached(`idx:relayers:${chainId}`, 300_000, async () => {
    const res = await pool.query<{
      signer: string;
      tx_count: string;
      fees_paid: string | null;
      last_height: string;
      last_time: string;
      total: string;
    }>(
      // The window matches every other indexed read: only heights we can vouch
      // for, so a partially backfilled chain understates rather than misleads.
      `WITH relays AS (
         SELECT signer, fee_amount, height, time
           FROM tx
          WHERE chain_id = $1
            AND signer IS NOT NULL
            AND msg_types && $2::text[]
            AND height BETWEEN $3 AND $4
       )
       SELECT signer,
              count(*)::text                        AS tx_count,
              COALESCE(sum(fee_amount), 0)::text    AS fees_paid,
              max(height)::text                     AS last_height,
              max(time)::text                       AS last_time,
              (SELECT count(*) FROM relays)::text   AS total
         FROM relays
        GROUP BY signer
        ORDER BY count(*) DESC
        LIMIT $5`,
      [chainId, msgTypes, c.lowest, c.highest, limit]
    );

    return {
      operators: res.rows.map((r) => ({
        address: r.signer,
        txCount: Number(r.tx_count),
        feesPaid: r.fees_paid ?? "0",
        lastHeight: Number(r.last_height),
        lastTime: r.last_time,
      })),
      totalTxs: Number(res.rows[0]?.total ?? 0),
      since: c.from,
      fromGenesis: c.lowest <= 1,
    };
  }).catch(() => null);
}

export interface IndexedAccountTx {
  hash: string;
  height: string;
  time: string;
  code: number;
  msgTypes: string[];
  feeDenom: string | null;
  feeAmount: string | null;
  /** The value movement involving this account, when there was one. */
  transfer: {
    from: string | null;
    to: string | null;
    denom: string;
    amount: string;
  } | null;
}

export interface IndexedAccountTxs {
  /** True when the index reaches the first block — see ProposerStats. */
  fromGenesis: boolean;
  txs: IndexedAccountTx[];
  /** Start of the window these came from — never "all of history". */
  since: string;
  /** True when more exist below the returned page. */
  more: boolean;
}

/**
 * Transactions an account signed or received value in.
 *
 * This is a repair, not an optimisation. Cosmos account history has always come
 * from tx search, and AtomOne's public LCDs have stopped serving it — one
 * answers "transaction indexing is disabled", the other returns zero results
 * for accounts that have plainly transacted. Account pages therefore show
 * nothing, exactly as proposal votes did.
 *
 * Two sources unioned, because "my transactions" means both: what the account
 * signed, keyed by tx.signer, and what arrived at it, keyed by the transfer's
 * recipient. A tx-search-based implementation needs two separate paged queries
 * and de-duplication to answer the same question.
 *
 * Fee-kind transfers are excluded from counterparty matching: every signed
 * transaction pays a fee, so joining on them would make the fee collector the
 * counterparty of everything.
 */
export async function accountTxsFromIndexer(
  chainId: string,
  address: string,
  limit = 50
): Promise<IndexedAccountTxs | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  const c = await coverage(chainId);
  if (!c) return null;

  try {
    const res = await pool.query<{
      hash: string;
      height: string;
      time: string;
      code: number;
      msg_types: string[];
      fee_denom: string | null;
      fee_amount: string | null;
      from_addr: string | null;
      to_addr: string | null;
      denom: string | null;
      amount: string | null;
    }>(
      // One row per transaction. A transaction can carry several transfers, so
      // DISTINCT ON keeps the first and leaves the detail page to show the rest
      // — a list view wants one line per transaction, not one per coin moved.
      `WITH mine AS (
         SELECT hash FROM tx
          WHERE chain_id = $1 AND signer = $2
            AND height BETWEEN $3 AND $4
         UNION
         SELECT tx_hash AS hash FROM transfer
          WHERE chain_id = $1 AND kind <> 'fee'
            AND (from_addr = $2 OR to_addr = $2)
            AND height BETWEEN $3 AND $4
       )
       SELECT DISTINCT ON (t.height, t.hash)
              t.hash, t.height::text, t.time::text, t.code, t.msg_types,
              t.fee_denom, t.fee_amount::text,
              tr.from_addr, tr.to_addr, tr.denom, tr.amount::text
         FROM tx t
         JOIN mine ON mine.hash = t.hash
         LEFT JOIN transfer tr
           ON tr.chain_id = t.chain_id AND tr.tx_hash = t.hash
          AND tr.kind <> 'fee'
          AND (tr.from_addr = $2 OR tr.to_addr = $2)
        WHERE t.chain_id = $1
        ORDER BY t.height DESC, t.hash, tr.msg_index, tr.coin_index
        LIMIT $5`,
      [chainId, address, c.lowest, c.highest, limit + 1]
    );

    const rows = res.rows.slice(0, limit);
    return {
      txs: rows.map((r) => ({
        hash: r.hash,
        height: r.height,
        time: r.time,
        code: r.code,
        msgTypes: r.msg_types ?? [],
        feeDenom: r.fee_denom,
        feeAmount: r.fee_amount,
        transfer:
          r.denom && r.amount
            ? {
                from: r.from_addr,
                to: r.to_addr,
                denom: r.denom,
                amount: r.amount,
              }
            : null,
      })),
      since: c.from,
      fromGenesis: c.lowest <= 1,
      // One extra row was requested purely to answer this without a count.
      more: res.rows.length > limit,
    };
  } catch {
    return null;
  }
}

/**
 * The most recent transactions on a chain, however far back they are.
 *
 * The live path scans a fixed window of recent blocks, which answers "what
 * happened lately" and not "what happened last". On a quiet chain most of that
 * window is empty blocks, so the tab can show two transactions while the chain
 * has thousands — the window is the limit, not the activity.
 *
 * Indexed, "the last fifty transactions" is exactly what it sounds like.
 */
export async function recentTxsFromIndexer(
  chainId: string,
  limit = 50
): Promise<IndexedAccountTx[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  const c = await coverage(chainId);
  if (!c) return null;

  return cached(`idx:recenttx:${chainId}`, 5_000, async () => {
    const res = await pool.query<{
      hash: string;
      height: string;
      time: string;
      code: number;
      msg_types: string[];
      fee_denom: string | null;
      fee_amount: string | null;
      from_addr: string | null;
      to_addr: string | null;
      denom: string | null;
      amount: string | null;
    }>(
      // Same one-row-per-transaction shape as the account list: a transaction
      // moving three coins is one line here, not three.
      `SELECT DISTINCT ON (t.height, t.hash)
              t.hash, t.height::text, t.time::text, t.code, t.msg_types,
              t.fee_denom, t.fee_amount::text,
              tr.from_addr, tr.to_addr, tr.denom, tr.amount::text
         FROM tx t
         LEFT JOIN transfer tr
           ON tr.chain_id = t.chain_id AND tr.tx_hash = t.hash AND tr.kind <> 'fee'
        WHERE t.chain_id = $1 AND t.height BETWEEN $2 AND $3
        ORDER BY t.height DESC, t.hash, tr.msg_index, tr.coin_index
        LIMIT $4`,
      [chainId, c.lowest, c.highest, limit]
    );

    return res.rows.map((r) => ({
      hash: r.hash,
      height: r.height,
      time: r.time,
      code: r.code,
      msgTypes: r.msg_types ?? [],
      feeDenom: r.fee_denom,
      feeAmount: r.fee_amount,
      transfer:
        r.denom && r.amount
          ? { from: r.from_addr, to: r.to_addr, denom: r.denom, amount: r.amount }
          : null,
    }));
  }).catch(() => null);
}

/**
 * Each validator's bonded stake as of roughly 24 hours ago.
 *
 * Replaces reading a node's historical state, which only archive nodes retain —
 * on AtomOne one public endpoint refuses outright and the other is a rotating
 * proxy that is archive on one request and pruned on the next, so the column
 * appeared and vanished between refreshes.
 *
 * "Nearest snapshot at least 24h old" rather than "newest older than 24h",
 * because those differ when snapshots have been missed: a gap should widen the
 * window slightly, not silently compare against something far older.
 *
 * Null when no snapshot that old exists yet — a fresh install has no baseline,
 * and a wrong figure is worse than an absent one. Takes a day to become useful,
 * by construction.
 */
export async function stakeBaseline(
  chainId: string,
  windowMs = 86_400_000
): Promise<Map<string, string> | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  return cached(`idx:stakebase:${chainId}`, 300_000, async () => {
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    // The snapshot height closest to the cutoff, from the older side.
    const at = await pool.query<{ height: string | null }>(
      `SELECT height::text FROM validator_stake
        WHERE chain_id = $1 AND time <= $2
        ORDER BY time DESC
        LIMIT 1`,
      [chainId, cutoff]
    );
    const height = at.rows[0]?.height;
    if (!height) return null;

    const res = await pool.query<{ operator: string; tokens: string }>(
      `SELECT operator, tokens::text FROM validator_stake
        WHERE chain_id = $1 AND height = $2`,
      [chainId, height]
    );
    if (res.rows.length === 0) return null;

    return new Map(res.rows.map((r) => [r.operator, r.tokens]));
  }).catch(() => null);
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
  const pool = poolFor(chainId);
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

export interface GovParticipation {
  /** Proposals this account voted on. */
  voted: number;
  /** Proposals with any recorded vote, which is the fair denominator. */
  total: number;
  /** Count per option, heaviest option for split votes. */
  byOption: { option: string; count: number }[];
  /** When they last voted. */
  lastVote: string | null;
}

/**
 * How often an account has voted, and how.
 *
 * The denominator is proposals *with recorded votes*, not every proposal that
 * ever existed: a validator cannot be marked absent from a proposal that closed
 * before the indexed window, and one nobody voted on says nothing about anyone.
 *
 * Null without the indexer. The gov module deletes votes once it tallies, so
 * for a finished proposal this table is the only lasting record — the chain
 * cannot answer this question at all.
 */
export async function governanceParticipation(
  chainId: string,
  voter: string
): Promise<GovParticipation | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  return cached(`gov:participation:${chainId}:${voter}`, 300_000, async () => {
    const [totals, options] = await Promise.all([
      pool.query<{ voted: string; total: string; last: string | null }>(
        `SELECT
           (SELECT count(*) FROM vote WHERE chain_id = $1 AND voter = $2) AS voted,
           (SELECT count(DISTINCT proposal_id) FROM vote WHERE chain_id = $1) AS total,
           (SELECT max(time)::text FROM vote WHERE chain_id = $1 AND voter = $2) AS last`,
        [chainId, voter]
      ),
      pool.query<{ option: string; n: string }>(
        `SELECT option, count(*) n FROM vote
         WHERE chain_id = $1 AND voter = $2
         GROUP BY option ORDER BY n DESC`,
        [chainId, voter]
      ),
    ]);

    const row = totals.rows[0];
    if (!row) return null;
    return {
      voted: Number(row.voted),
      total: Number(row.total),
      byOption: options.rows.map((r) => ({ option: r.option, count: Number(r.n) })),
      lastVote: row.last,
    };
  });
}

export interface CommissionEarned {
  /** One entry per denom — AtomOne pays commission in ATONE and PHOTON. */
  byDenom: { denom: string; amount: string }[];
  /** How many times commission was withdrawn. */
  withdrawals: number;
  first: string | null;
  last: string | null;
}

/**
 * Commission a validator has actually taken, since genesis.
 *
 * Every explorer shows the commission *rate*. This is what the rate produced —
 * the sum of every withdraw_commission event the validator has ever emitted.
 * The chain cannot answer it: the distribution module carries only what is
 * currently outstanding, so once commission is withdrawn the amount survives
 * nowhere but in the block events we indexed.
 *
 * Attributed through the transaction signer, not the event. AtomOne's
 * `withdraw_commission` carries only `amount` and `msg_index` — there is no
 * validator attribute for extract.ts to store, so `transfer.from_addr` is null
 * on every commission row and filtering on it matches nothing. What does
 * identify the validator is who signed: MsgWithdrawValidatorCommission is
 * signable only by the validator's own account, so joining the transfer to its
 * transaction and matching the signer recovers the link the event never had.
 *
 * Takes the account address for that reason, not the operator.
 *
 * Note this is commission *withdrawn*, not earned-and-unclaimed — the
 * outstanding balance is a separate figure the chain still holds.
 */
export async function commissionEarned(
  chainId: string,
  account: string
): Promise<CommissionEarned | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  return cached(`commission:${chainId}:${account}`, 600_000, async () => {
    const { rows } = await pool.query<{
      denom: string;
      total: string;
      n: string;
      first: string | null;
      last: string | null;
    }>(
      `SELECT t.denom, sum(t.amount)::text total, count(*) n,
              min(t.time)::text first, max(t.time)::text last
       FROM transfer t
       JOIN tx x ON x.chain_id = t.chain_id AND x.hash = t.tx_hash
       WHERE t.chain_id = $1 AND t.kind = 'commission' AND x.signer = $2
       GROUP BY t.denom
       ORDER BY sum(t.amount) DESC`,
      [chainId, account]
    );
    if (rows.length === 0) return null;

    return {
      byDenom: rows.map((r) => ({ denom: r.denom, amount: r.total })),
      // Withdrawals move every denom at once, so the count is per event, not
      // per row — taking the max avoids multiplying by the number of denoms.
      withdrawals: Math.max(...rows.map((r) => Number(r.n))),
      first: rows.reduce<string | null>(
        (m, r) => (!m || (r.first && r.first < m) ? r.first : m),
        null
      ),
      last: rows.reduce<string | null>(
        (m, r) => (!m || (r.last && r.last > m) ? r.last : m),
        null
      ),
    };
  });
}

export interface StakePoint {
  time: string;
  tokens: string;
  jailed: boolean;
}

/**
 * A validator's bonded stake over time.
 *
 * validator_stake holds a snapshot per operator per sampled height, and until
 * now the only thing reading it was the 24h delta — one subtraction over a
 * table that describes a whole history. This returns the series.
 *
 * Sampled down to at most `points` rows in SQL rather than in JS: a year of
 * snapshots is far more than a sparkline can draw, and shipping them all to
 * render sixty pixels is waste at every layer.
 */
export async function stakeHistory(
  chainId: string,
  operator: string,
  days = 90,
  points = 60
): Promise<StakePoint[] | null> {
  const pool = poolFor(chainId);
  if (!pool) return null;

  return cached(`stakehist:${chainId}:${operator}:${days}`, 600_000, async () => {
    const { rows } = await pool.query<{
      time: string;
      tokens: string;
      jailed: boolean;
    }>(
      // Both casts are load-bearing. node-postgres sends parameters as text,
      // and Postgres will not infer ntile(text) or an interval from a bare
      // parameter — without them the query throws rather than returning
      // nothing, which the caller cannot tell apart.
      `WITH windowed AS (
         SELECT time, tokens, jailed,
                ntile($4::int) OVER (ORDER BY time) bucket
         FROM validator_stake
         WHERE chain_id = $1 AND operator = $2
           AND time > now() - make_interval(days => $3::int)
       )
       SELECT DISTINCT ON (bucket)
              time::text, tokens::text, jailed
       FROM windowed
       ORDER BY bucket, time DESC`,
      [chainId, operator, days, points]
    );
    return rows.length >= 2 ? rows : [];
  });
}
