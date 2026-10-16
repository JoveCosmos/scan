import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { createPool, commitBatch } from "../indexer/src/db";
import { extractBlock } from "../indexer/src/extract";

/**
 * Migration 013's derived data against a real Postgres (INDEXER_TEST_DATABASE_URL, a throwaway database with
 * indexer/sql applied): block_proposer_count behind proposer_blocks(), transfer.signer on commission rows and
 * validator_power.time. Chain ids are fake, so a shared database is safe.
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const atomone = (h: number) => extractBlock(fx(`atomone-block-${h}.json`), fx(`atomone-block-results-${h}.json`))!;

const P = "proposer-count-test", C = "validator-reads-test";
const TABLES = ["tx_party", "transfer", "tx_msg", "staking_event", "validator_power", "slash_event", "missed_signature",
                "ibc_packet", "gov_deposit", "gov_proposal", "vote_event", "vote", "validator_key", "tx", "block",
                "indexer_cursor", "address_tx_count", "block_gap", "block_proposer_count"];
const A = "AAAA", B = "BBBB", N = "NNNN";

describe.skipIf(!url)("migration 013: validator page reads", () => {
  let pool: Pool;
  const clean = async () => { for (const ch of [P, C]) for (const t of TABLES) await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [ch]); };
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;

  // The writer's own statement shape: INSERT ... ON CONFLICT DO UPDATE, one statement for many heights.
  // Heights 0..25009; proposer A on even heights, B on odd ones divisible by 3, none on the rest (NULL).
  const upsertRange = (lo: number, hi: number, proposer: (h: string) => string) =>
    pool.query(
      `INSERT INTO block (chain_id, height, time, proposer_cons, tx_count, extract_version)
       SELECT $1, h, timestamptz '2026-01-01' + h * interval '6 seconds', ${proposer("h")}, 0, 4
         FROM generate_series($2::bigint, $3::bigint) h
       ON CONFLICT (chain_id, height) DO UPDATE SET time = EXCLUDED.time, proposer_cons = EXCLUDED.proposer_cons`,
      [P, lo, hi]
    );
  const pattern = (h: string) => `CASE WHEN ${h} % 2 = 0 THEN '${A}' WHEN ${h} % 3 = 0 THEN '${B}' END`;

  const direct = async (cons: string, lo: number, hi: number) =>
    (await q(`SELECT count(*)::int AS n, max(height)::int AS last, max(time) AS t FROM block
               WHERE chain_id = $1 AND proposer_cons = $2 AND height BETWEEN $3 AND $4`, [P, cons, lo, hi]))[0];
  const rolled = async (cons: string, lo: number, hi: number) =>
    (await q(`SELECT blocks::int AS n, last_height::int AS last, last_time AS t FROM proposer_blocks($1, $2, $3, $4)`, [P, cons, lo, hi]))[0];
  const same = async (lo: number, hi: number) => {
    for (const cons of [A, B, N]) expect(await rolled(cons, lo, hi), `${cons} ${lo}..${hi}`).toEqual(await direct(cons, lo, hi));
  };

  beforeAll(async () => { pool = createPool(url!); await clean(); });
  afterAll(async () => { await clean(); await pool?.end(); });

  it("counts a proposer's blocks exactly in any window", async () => {
    await upsertRange(0, 25009, pattern);
    const windows: [number, number][] = [
      [0, 0], [0, 9998], [0, 9999], [0, 10000], [1, 9999], [9999, 10000], [9999, 10001], [10000, 19999],
      [10000, 20000], [10001, 19998], [5, 15], [9990, 20010], [0, 25009], [1, 25009], [12345, 12345],
      [20000, 25009], [25009, 30000], [30000, 40000], [7, 3],
    ];
    // and a spread of windows that start and end anywhere
    for (let i = 0; i < 40; i++) {
      const lo = (i * 7919) % 25010, len = (i * 104729) % 23000;
      windows.push([lo, lo + len]);
    }
    for (const [lo, hi] of windows) await same(lo, hi);
    expect(await rolled(A, 7, 3)).toEqual({ n: 0, last: null, t: null });
  });

  it("does not count a block twice when the same heights are written again", async () => {
    const before = await q("SELECT bucket::int, blocks FROM block_proposer_count WHERE chain_id = $1 ORDER BY proposer_cons, bucket", [P]);
    await upsertRange(0, 25009, pattern);
    await upsertRange(9000, 11000, pattern);
    expect(await q("SELECT bucket::int, blocks FROM block_proposer_count WHERE chain_id = $1 ORDER BY proposer_cons, bucket", [P])).toEqual(before);
    await same(0, 25009);
  });

  it("moves the count when a rewrite changes the proposer, and drops a bucket that empties", async () => {
    // B takes every height of bucket 1 and a few of bucket 2; A loses them.
    await upsertRange(10000, 20004, () => `'${B}'`);
    for (const [lo, hi] of [[0, 25009], [10000, 19999], [9999, 20005], [20000, 20004], [15000, 15000]] as const) await same(lo, hi);
    expect(await q("SELECT 1 FROM block_proposer_count WHERE chain_id = $1 AND proposer_cons = $2 AND bucket = 1", [P, A])).toEqual([]);
    // and back to no proposer at all
    await upsertRange(10000, 10099, () => "NULL");
    await same(0, 25009);
    await same(10000, 19999);
  });

  it("takes deleted blocks off, and leaves nothing once a chain's blocks are gone", async () => {
    await pool.query("DELETE FROM block WHERE chain_id = $1 AND height BETWEEN 3000 AND 13000", [P]);
    for (const [lo, hi] of [[0, 25009], [0, 9999], [10000, 19999], [2999, 13001]] as const) await same(lo, hi);
    await pool.query("DELETE FROM block WHERE chain_id = $1", [P]);
    expect(await q("SELECT count(*)::int AS n FROM block_proposer_count WHERE chain_id = $1", [P])).toEqual([{ n: 0 }]);
  });

  it("counts blocks written through the follower's commit, once", async () => {
    const b = atomone(9829661);
    await commitBatch(pool, C, [b]);
    await commitBatch(pool, C, [b]);
    expect(await q("SELECT blocks::int AS n, last_height::int AS h FROM proposer_blocks($1, $2, 0, 20000000)", [C, b.block.proposerCons]))
      .toEqual([{ n: 1, h: 9829661 }]);
  });

  it("puts the withdrawing transaction's signer on commission rows, and only on those", async () => {
    const b = atomone(10838442);
    await commitBatch(pool, C, [b]);
    const signer = b.txs[0].signer;
    expect(signer).toMatch(/^atone1/);
    const rows = await q("SELECT kind, signer, count(*)::int AS n FROM transfer WHERE chain_id = $1 GROUP BY 1, 2 ORDER BY 1", [C]);
    expect(rows).toEqual([
      { kind: "commission", signer, n: 2 },
      { kind: "fee", signer: null, n: 1 },
      { kind: "reward", signer: null, n: 1 },
      { kind: "transfer", signer: null, n: 3 },
    ]);
    // Scan's old join and the new single-table read agree.
    const viaJoin = await q(`SELECT t.denom, sum(t.amount)::text AS total, count(*)::int AS n FROM transfer t
                               JOIN tx x ON x.chain_id = t.chain_id AND x.hash = t.tx_hash
                              WHERE t.chain_id = $1 AND t.kind = 'commission' AND x.signer = $2 GROUP BY 1 ORDER BY 1`, [C, signer]);
    const viaRow = await q(`SELECT denom, sum(amount)::text AS total, count(*)::int AS n FROM transfer
                             WHERE chain_id = $1 AND kind = 'commission' AND signer = $2 GROUP BY 1 ORDER BY 1`, [C, signer]);
    expect(viaJoin.length).toBe(2);
    expect(viaRow).toEqual(viaJoin);
  });

  it("keeps the signer when a refill rewrites the transaction, and the migration's fill restores a missing one", async () => {
    const b = atomone(10838442);
    await commitBatch(pool, C, [b]);
    expect(await q("SELECT count(*)::int AS n FROM transfer WHERE chain_id = $1 AND kind = 'commission' AND signer IS NOT NULL", [C])).toEqual([{ n: 2 }]);
    // rows written before the column existed
    await pool.query("UPDATE transfer SET signer = NULL WHERE chain_id = $1", [C]);
    await pool.query(`UPDATE transfer t SET signer = x.signer
                        FROM tx x
                       WHERE t.kind = 'commission' AND t.signer IS NULL
                         AND x.chain_id = t.chain_id AND x.hash = t.tx_hash AND x.signer IS NOT NULL`);
    expect(await q("SELECT count(*)::int AS n FROM transfer WHERE chain_id = $1 AND kind = 'commission' AND signer = $2", [C, b.txs[0].signer]))
      .toEqual([{ n: 2 }]);
  });

  it("gives every validator_power row its block's time", async () => {
    for (const h of [9829661, 9968835]) await commitBatch(pool, C, [atomone(h)]);
    const rows = await q(`SELECT vp.height::int AS h, vp.cons_addr, vp.time = b.time AS same, vp.time IS NOT NULL AS has
                            FROM validator_power vp JOIN block b ON b.chain_id = vp.chain_id AND b.height = vp.height
                           WHERE vp.chain_id = $1 ORDER BY 1, 2`, [C]);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ same: true, has: true });
    // an upsert of the power alone keeps the time
    await commitBatch(pool, C, [atomone(9968835)]);
    expect(await q("SELECT count(*)::int AS n FROM validator_power WHERE chain_id = $1 AND time IS NULL", [C])).toEqual([{ n: 0 }]);
  });
});
