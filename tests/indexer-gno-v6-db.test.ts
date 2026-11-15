import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { createPool } from "../indexer/src/db";
import { commitGno } from "../indexer/src/gno-worker";
import { extractGno, type GnoBlockIn, type GnoTxIn } from "../indexer/src/gno";

/**
 * Migration 015 against a real Postgres (INDEXER_TEST_DATABASE_URL, a throwaway database with indexer/sql applied):
 * the coins each message sends, written and covered. Chain id is fake, so a shared database is safe.
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;
const at = (h: number) => {
  const d = JSON.parse(readFileSync(join(__dirname, "fixtures", `gno-v5-gnoland-1-${h}.json`), "utf8")) as { blocks: GnoBlockIn[]; txs: GnoTxIn[] };
  return extractGno(d.blocks, d.txs);
};
const C = "gno-v6-test";
const TABLES = ["gno_grc20_transfer", "gno_grc20_balance", "gno_grc20_token", "gno_tx_msg", "gno_tx_party", "gno_tx", "block",
                "indexer_cursor", "address_tx_count", "block_gap", "block_proposer_count"];

describe.skipIf(!url)("migration 015: the coins each gno message sends", () => {
  let pool: Pool;
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
  const clean = async () => { for (const t of TABLES) await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [C]); };

  beforeAll(async () => { pool = createPool(url!); await clean(); });
  afterAll(async () => { await clean(); await pool?.end(); });

  it("writes a send's amount and a call's send, ugnot as a number, and none where nothing is sent", async () => {
    await commitGno(pool, C, at(113002), 113002, null, { cursor: false });
    await commitGno(pool, C, at(339064), 339064, null, { cursor: false });
    expect(await q("SELECT kind, func, coins, ugnot::text FROM gno_tx_msg WHERE chain_id = $1 ORDER BY height, func NULLS FIRST, gno_tx_msg.ugnot DESC NULLS LAST", [C])).toEqual([
      { kind: "send", func: null, coins: "3297800400ugnot", ugnot: "3297800400" },
      { kind: "send", func: null, coins: "292000000ugnot", ugnot: "292000000" },
      { kind: "send", func: null, coins: "99989000ugnot", ugnot: "99989000" },
      { kind: "call", func: "Approve", coins: null, ugnot: null },
      { kind: "call", func: "Deposit", coins: "3540000ugnot", ugnot: "3540000" },
      { kind: "call", func: "ExactInSwapRoute", coins: null, ugnot: null },
    ]);
    expect(await q("SELECT sum(ugnot)::text AS s FROM gno_tx_msg WHERE chain_id = $1", [C])).toEqual([{ s: "3693329400" }]);
  });

  it("is covered where blocks are at version 6", async () => {
    expect(await q("SELECT lo::int, hi::int FROM indexer_coverage($1, 'gno_msg_coins')", [C])).not.toEqual([]);
  });
});
