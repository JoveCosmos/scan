import type { Pool } from "pg";

/**
 * Snapshots of the bonded validator set.
 *
 * The one thing this indexer reads that is not in a block. Bonded stake is
 * module state rather than an event — a delegation emits a message, but the
 * resulting total is computed by the staking module and never written into a
 * block — so it has to be asked for and recorded.
 *
 * Read over LCD rather than RPC because the staking module's REST endpoint
 * returns it directly; the equivalent over CometBFT RPC is an ABCI query
 * carrying protobuf, which would mean decoding for no gain.
 */

export interface StakeSnapshotRow {
  operator: string;
  tokens: string;
  jailed: boolean;
}

interface RawValidator {
  operator_address?: string;
  tokens?: string;
  jailed?: boolean;
}

/**
 * Every bonded validator's stake, right now.
 *
 * Paged in full. A single page would silently snapshot whichever subset the
 * module happened to return first, and a validator missing from a snapshot is
 * indistinguishable from one that had left the set.
 */
export async function fetchBondedSet(
  lcdUrl: string,
  timeoutMs = 15_000
): Promise<StakeSnapshotRow[]> {
  const base = lcdUrl.replace(/\/$/, "");
  const out: StakeSnapshotRow[] = [];
  let nextKey: string | null = null;

  // Bounded: a broken pagination key must not spin forever.
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      status: "BOND_STATUS_BONDED",
      "pagination.limit": "200",
    });
    if (nextKey) params.set("pagination.key", nextKey);

    const res = await fetch(
      `${base}/cosmos/staking/v1beta1/validators?${params}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    if (!res.ok) throw new Error(`staking validators responded ${res.status}`);

    const body = (await res.json()) as {
      validators?: RawValidator[];
      pagination?: { next_key?: string | null };
    };

    for (const v of body.validators ?? []) {
      if (!v.operator_address || v.tokens === undefined) continue;
      out.push({
        operator: v.operator_address,
        tokens: v.tokens,
        jailed: v.jailed === true,
      });
    }

    nextKey = body.pagination?.next_key || null;
    if (!nextKey) break;
  }

  return out;
}

/**
 * Write one snapshot.
 *
 * Upserts on the key, so re-running a height is harmless — the same property
 * every other write here has, and what lets a crash mid-snapshot be repaired by
 * simply doing it again.
 */
export async function writeSnapshot(
  pool: Pool,
  chainId: string,
  height: number,
  time: string,
  rows: StakeSnapshotRow[]
): Promise<void> {
  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `INSERT INTO validator_stake (chain_id, height, time, operator, tokens, jailed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (chain_id, height, operator) DO UPDATE SET
           tokens = EXCLUDED.tokens,
           jailed = EXCLUDED.jailed`,
        [chainId, height, time, r.operator, r.tokens, r.jailed]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** When this chain was last snapshotted, or null if never. */
export async function lastSnapshotAt(
  pool: Pool,
  chainId: string
): Promise<Date | null> {
  const res = await pool.query<{ at: string | null }>(
    `SELECT max(time)::text AS at FROM validator_stake WHERE chain_id = $1`,
    [chainId]
  );
  const at = res.rows[0]?.at;
  return at ? new Date(at) : null;
}

/**
 * Whether enough time has passed to take another.
 *
 * Driven by wall time rather than a block count, because block time varies and
 * the consumer is a wall-clock question — "how much changed in 24 hours", not
 * "in 14,400 blocks".
 */
export function isSnapshotDue(
  last: Date | null,
  now: Date,
  intervalMs: number
): boolean {
  if (!last) return true;
  return now.getTime() - last.getTime() >= intervalMs;
}
