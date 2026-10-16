import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { createPool, commitBatch, clearGaps, recordGaps, staleHeights } from "../indexer/src/db";
import { commitGno } from "../indexer/src/gno-worker";
import { extractGno, GNO_EXTRACT_VERSION, type GnoBlockIn, type GnoTxIn } from "../indexer/src/gno";
import { extractBlock } from "../indexer/src/extract";

/**
 * gno_tx / gno_tx_party, address_tx_count and the coverage function, against a
 * real Postgres (INDEXER_TEST_DATABASE_URL, a throwaway database with indexer/sql
 * applied). Chain ids are fake, so a shared database is safe.
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const gno = (h: number) => { const d = fx(`gno-gnoland-1-${h}.json`) as { blocks: GnoBlockIn[]; txs: GnoTxIn[] }; return extractGno(d.blocks, d.txs); };

const G = "gno-test-1", C = "cosmos-count-test", V = "coverage-test";
const TABLES = ["gno_tx_party", "gno_tx", "tx_party", "transfer", "tx", "block", "indexer_cursor", "address_tx_count", "block_gap",
                "tx_msg", "staking_event", "validator_power", "slash_event", "missed_signature"];
const SENDER = "g1juss2tuc97sr77rn6vprhh9lr7d9e07uu68x59";

describe.skipIf(!url)("gno projection and address_tx_count", () => {
  let pool: Pool;
  const count = async (chain: string, addr: string) =>
    (await pool.query("SELECT tx_count::int AS n, first_height::int AS f, last_height::int AS l, first_time, last_time FROM address_tx_count WHERE chain_id=$1 AND address=$2", [chain, addr])).rows[0];
  const clean = async () => { for (const ch of [G, C, V]) for (const t of TABLES) await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [ch]); };

  beforeAll(async () => { pool = createPool(url!); await clean(); });
  afterAll(async () => { await clean(); await pool?.end(); });

  it("writes a gno block, transaction and parties, with the cursor", async () => {
    await commitGno(pool, G, gno(337001), 337001, 337010);
    const tx = (await pool.query("SELECT * FROM gno_tx WHERE chain_id=$1", [G])).rows;
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ height: "337001", success: true, msg_types: ["BankMsgSend"], fee_amount: "1027", fee_denom: "ugnot" });
    const b = (await pool.query("SELECT extract_version FROM block WHERE chain_id=$1 AND height=337001", [G])).rows[0];
    expect(b.extract_version).toBe(GNO_EXTRACT_VERSION);
    const c = (await pool.query("SELECT last_height, head_height FROM indexer_cursor WHERE chain_id=$1", [G])).rows[0];
    expect(c).toEqual({ last_height: "337001", head_height: "337010" });
  });

  it("counts each (address, transaction) once, with first and last activity", async () => {
    const r = await count(G, SENDER);
    expect(r).toMatchObject({ n: 1, f: 337001, l: 337001 });
    expect(r.first_time.toISOString()).toBe("2026-09-26T03:13:02.637Z");
  });

  it("does not count again when the same range is written again (a refill)", async () => {
    await commitGno(pool, G, gno(337001), 337001, 337010);
    expect((await count(G, SENDER)).n).toBe(1);
  });

  it("widens first and last as history arrives from either side", async () => {
    // A second (made-up) transaction by the same sender, earlier and later.
    for (const h of [330000, 339000]) {
      const x = gno(337001);
      x.blocks[0].height = String(h);
      x.txs[0] = { ...x.txs[0], height: String(h), hash: x.txs[0].hash.slice(0, 58) + String(h) };
      x.parties = x.parties.map((p) => ({ ...p, height: String(h), txHash: x.txs[0].hash }));
      await commitGno(pool, G, x, h, h);
    }
    expect(await count(G, SENDER)).toMatchObject({ n: 3, f: 330000, l: 339000 });
  });

  it("recounts an address exactly when its rows are deleted", async () => {
    await pool.query("DELETE FROM gno_tx_party WHERE chain_id=$1 AND height=339000", [G]);
    expect(await count(G, SENDER)).toMatchObject({ n: 2, f: 330000, l: 337001 });
    await pool.query("DELETE FROM gno_tx_party WHERE chain_id=$1", [G]);
    expect(await count(G, SENDER)).toBeUndefined();
  });

  it("counts Cosmos tx_party rows the same way, and a rewrite does not double them", async () => {
    const b = extractBlock(fx("atomone-block-9294803.json"), fx("atomone-block-results-9294803.json"))!;
    await commitBatch(pool, C, [b]);
    await commitBatch(pool, C, [b]);
    const grantee = "atone1vvumkjdmen9fsgu88zqv8eulpn79g4g0lner8s";
    expect(await count(C, grantee)).toMatchObject({ n: 1, f: 9294803, l: 9294803 });
    const n = (await pool.query("SELECT count(*)::int n FROM address_tx_count WHERE chain_id=$1", [C])).rows[0].n;
    const p = (await pool.query("SELECT count(DISTINCT address)::int n FROM tx_party WHERE chain_id=$1", [C])).rows[0].n;
    expect(n).toBe(p);
  });

  it("ends coverage at the newest block that carries the capability, not at a newer older-version block", async () => {
    // gno-signatures writes blocks at version 3 ahead of the follower
    for (const [h, v] of [[1, 4], [2, 4], [3, 4], [4, 3]] as const)
      await pool.query("INSERT INTO block (chain_id, height, time, tx_count, extract_version) VALUES ($1,$2,now(),0,$3)", [V, h, v]);
    const r = (await pool.query("SELECT lo::int, hi::int FROM indexer_coverage($1,'gno_tx_party')", [V])).rows;
    expect(r).toEqual([{ lo: 1, hi: 3 }]);
    await pool.query("UPDATE block SET extract_version = 3 WHERE chain_id=$1 AND height=2", [V]);
    expect((await pool.query("SELECT lo::int, hi::int FROM indexer_coverage($1,'gno_tx_party')", [V])).rows).toEqual([{ lo: 3, hi: 3 }]);
  });

  it("keeps a recorded gap while its height still holds an older row, and knows it is stale", async () => {
    await recordGaps(pool, V, [2], "test");
    await clearGaps(pool, V, 1, 4, 4);
    expect((await pool.query("SELECT lo::int FROM block_gap WHERE chain_id=$1", [V])).rows).toEqual([{ lo: 2 }]);
    expect(await staleHeights(pool, V, 1, 5, 4)).toEqual([2, 4, 5]);
    await pool.query("UPDATE block SET extract_version = 4 WHERE chain_id=$1 AND height=2", [V]);
    await clearGaps(pool, V, 1, 4, 4);
    expect((await pool.query("SELECT count(*)::int n FROM block_gap WHERE chain_id=$1", [V])).rows[0].n).toBe(0);
  });
});
