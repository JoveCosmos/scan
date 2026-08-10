import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { nextRange, type BackfillTarget } from "../indexer/src/backfill";

/**
 * Backfill walks *downward* from the lowest indexed height, deriving its
 * position from the data rather than a cursor. That is what makes a run which
 * dies on day three resume exactly where it stopped, so it is worth testing
 * against real Postgres rather than a mock.
 *
 * Skipped unless INDEXER_TEST_DATABASE_URL points at a throwaway database.
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("backfill range", () => {
  let pool: Pool;
  const chainId = "backfill-test";

  const target = (over: Partial<BackfillTarget> = {}): BackfillTarget => ({
    chainId,
    rpcUrl: "http://unused",
    floor: 1,
    ...over,
  });

  const seed = (height: number) =>
    pool.query(
      `INSERT INTO block (chain_id, height, time, tx_count)
       VALUES ($1, $2, now(), 0)
       ON CONFLICT DO NOTHING`,
      [chainId, height]
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query("DELETE FROM block WHERE chain_id = $1", [chainId]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM block WHERE chain_id = $1", [chainId]);
    await pool.end();
  });

  it("needs an anchor when the chain has nothing indexed", async () => {
    expect(await nextRange(pool, target(), 100)).toBeNull();
  });

  it("starts just below the given anchor", async () => {
    const range = await nextRange(pool, target({ from: 1000 }), 100);
    expect(range).toEqual({ from: 999, to: 900 });
  });

  it("prefers what is already indexed over the anchor", async () => {
    // The anchor only seeds the first pass; after that the data is the truth.
    await seed(500);
    const range = await nextRange(pool, target({ from: 1000 }), 100);
    expect(range).toEqual({ from: 499, to: 400 });
  });

  it("resumes from the new low after progress, without extra state", async () => {
    await seed(400);
    const range = await nextRange(pool, target({ from: 1000 }), 100);
    expect(range).toEqual({ from: 399, to: 300 });
  });

  it("never descends past the floor", async () => {
    const range = await nextRange(pool, target({ floor: 350 }), 100);
    expect(range).toEqual({ from: 399, to: 350 });
  });

  it("reports completion once the floor is indexed", async () => {
    await seed(350);
    expect(await nextRange(pool, target({ floor: 350 }), 100)).toBeNull();
  });

  it("ignores heights belonging to other chains", async () => {
    // One database serves every chain, so min(height) must be scoped.
    await pool.query(
      `INSERT INTO block (chain_id, height, time, tx_count)
       VALUES ('other-chain', 1, now(), 0) ON CONFLICT DO NOTHING`
    );
    const range = await nextRange(pool, target({ floor: 1 }), 100);
    expect(range!.from).toBe(349);
    await pool.query("DELETE FROM block WHERE chain_id = 'other-chain'");
  });
});

describe.skipIf(!url)("refill mode", () => {
  let pool: Pool;
  const chainId = "refill-test";

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query("DELETE FROM block WHERE chain_id = $1", [chainId]);
    // Pretend this range was already indexed by an older extractor.
    for (const h of [500, 499, 498]) {
      await pool.query(
        `INSERT INTO block (chain_id, height, time, tx_count)
         VALUES ($1,$2,now(),0) ON CONFLICT DO NOTHING`,
        [chainId, h]
      );
    }
  });

  afterAll(async () => {
    await pool.query("DELETE FROM block WHERE chain_id = $1", [chainId]);
    await pool.end();
  });

  it("re-reads heights that are already stored", async () => {
    // Resume mode would refuse: min(height) is 498, so it only looks below 498.
    // Refill must revisit 500 to pick up newly extractable data.
    const range = await nextRange(
      pool,
      { chainId, rpcUrl: "http://unused", floor: 498, from: 500, refill: true },
      100
    );
    expect(range).toEqual({ from: 500, to: 498 });
  });

  it("walks from the caller's position, not the database", async () => {
    const range = await nextRange(
      pool,
      { chainId, rpcUrl: "http://unused", floor: 1, from: 500, refill: true },
      50,
      450
    );
    expect(range).toEqual({ from: 450, to: 401 });
  });

  it("stops at the floor", async () => {
    const range = await nextRange(
      pool,
      { chainId, rpcUrl: "http://unused", floor: 400, from: 500, refill: true },
      100,
      399
    );
    expect(range).toBeNull();
  });

  it("resume mode still refuses to revisit stored heights", async () => {
    // The contrast that makes refill necessary.
    const range = await nextRange(
      pool,
      { chainId, rpcUrl: "http://unused", floor: 498, from: 500 },
      100
    );
    expect(range).toBeNull();
  });
});
