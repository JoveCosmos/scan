import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool, commitBatch, readCursor } from "../indexer/src/db";
import { extractBlock, type ExtractedBlock } from "../indexer/src/extract";
import type { Pool } from "pg";

/**
 * Exercises the real database, so it only runs where one exists.
 *
 * Set INDEXER_TEST_DATABASE_URL to a throwaway Postgres and these run; without
 * it they skip, so `npm test` stays green on a laptop with no container. The
 * schema in indexer/sql must already be applied.
 *
 *   INDEXER_TEST_DATABASE_URL=postgres://indexer:pw@127.0.0.1:5433/gata_indexer \
 *     npx vitest run tests/indexer-db.test.ts
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;
const CHAIN = "test-chain-1";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

function sampleBlock(): ExtractedBlock {
  return extractBlock(
    fixture("atomone-block-9823288.json"),
    fixture("atomone-block-results-9823288.json")
  )!;
}

describe.skipIf(!url)("indexer database", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(url!);
    // A clean slate, scoped to this fake chain id so a real database is safe.
    await pool.query("DELETE FROM transfer WHERE chain_id = $1", [CHAIN]);
    await pool.query("DELETE FROM tx WHERE chain_id = $1", [CHAIN]);
    await pool.query("DELETE FROM block WHERE chain_id = $1", [CHAIN]);
    await pool.query("DELETE FROM indexer_cursor WHERE chain_id = $1", [CHAIN]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("starts with no cursor", async () => {
    expect(await readCursor(pool, CHAIN)).toBeNull();
  });

  it("writes a block, its txs and transfers, and advances the cursor", async () => {
    const b = sampleBlock();
    await commitBatch(pool, CHAIN, [b]);

    expect(await readCursor(pool, CHAIN)).toBe(9823288);

    const txs = await pool.query("SELECT * FROM tx WHERE chain_id = $1", [CHAIN]);
    expect(txs.rowCount).toBe(1);
    expect(txs.rows[0].fee_denom).toBe("uphoton");
    // numeric comes back as a string, which is the point — no float rounding.
    expect(txs.rows[0].fee_amount).toBe("220335");
    expect(txs.rows[0].msg_types).toHaveLength(4);

    const transfers = await pool.query(
      "SELECT * FROM transfer WHERE chain_id = $1",
      [CHAIN]
    );
    expect(transfers.rowCount).toBe(b.transfers.length);
  });

  it("is idempotent — replaying a height changes nothing", async () => {
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM transfer WHERE chain_id = $1",
      [CHAIN]
    );

    // Crash recovery replays heights, so this must not duplicate or error.
    await commitBatch(pool, CHAIN, [sampleBlock()]);
    await commitBatch(pool, CHAIN, [sampleBlock()]);

    const after = await pool.query(
      "SELECT count(*)::int AS n FROM transfer WHERE chain_id = $1",
      [CHAIN]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const blocks = await pool.query(
      "SELECT count(*)::int AS n FROM block WHERE chain_id = $1",
      [CHAIN]
    );
    expect(blocks.rows[0].n).toBe(1);
  });

  it("never moves the cursor backwards", async () => {
    // An out-of-order batch must not rewind progress and strand later heights.
    const older = sampleBlock();
    older.block.height = "1000";
    older.txs = [];
    older.transfers = [];
    await commitBatch(pool, CHAIN, [older]);

    expect(await readCursor(pool, CHAIN)).toBe(9823288);
  });

  it("stores amounts wide enough for any Cosmos supply", async () => {
    // 78 digits: far beyond what a double could hold exactly.
    const huge = "123456789012345678901234567890";
    const b = sampleBlock();
    b.block.height = "9823289";
    b.txs = [];
    b.transfers = [
      {
        txHash: "WIDE",
        msgIndex: 0,
        coinIndex: 0,
        height: "9823289",
        time: b.block.time,
        kind: "transfer",
        fromAddr: "a",
        toAddr: "b",
        denom: "uatone",
        amount: huge,
      },
    ];
    await commitBatch(pool, CHAIN, [b]);

    const res = await pool.query(
      "SELECT amount FROM transfer WHERE chain_id = $1 AND tx_hash = 'WIDE'",
      [CHAIN]
    );
    expect(res.rows[0].amount).toBe(huge);
  });
});
