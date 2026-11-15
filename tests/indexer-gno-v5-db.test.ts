import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { createPool } from "../indexer/src/db";
import { commitGno, gnoOnce, gnoRefill } from "../indexer/src/gno-worker";
import { extractGno, GNO_EXTRACT_VERSION, type GnoBlockIn, type GnoSource, type GnoTxIn } from "../indexer/src/gno";

/**
 * Migration 014 against a real Postgres (INDEXER_TEST_DATABASE_URL, a throwaway database with indexer/sql
 * applied): gno_tx_msg, the GRC20 tables and the balances the database keeps, the refill and the genesis start.
 * Chain ids are fake, so a shared database is safe.
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;
const raw = (h: number) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `gno-v5-gnoland-1-${h}.json`), "utf8")) as { blocks: GnoBlockIn[]; txs: GnoTxIn[] };
const at = (h: number) => { const d = raw(h); return extractGno(d.blocks, d.txs); };

const G = "gno-v5-test", R = "gno-refill-test", F = "gno-genesis-test";
const TABLES = ["gno_grc20_transfer", "gno_grc20_balance", "gno_grc20_token", "gno_tx_msg", "gno_tx_party", "gno_tx", "block",
                "indexer_cursor", "address_tx_count", "block_gap", "block_proposer_count"];
const GNS = "gno.land/r/gnoswap/gns.GNS.0000000", WUGNOT = "gno.land/r/gnoland/wugnot.wugnot.0000000";
const MINTED = ["g1plxd74hnxyjvh309nfcndp53ypvv93yp5rd7dk", "g1y7h659patawdy99mlufj9lp3t9cwpt8fq852zq"];

/** A tx-indexer that serves the fixtures, as GnoSource would. */
function fakeSource(chainId: string, heights: number[]): GnoSource & { asked: [number, number][] } {
  const data = heights.map(raw);
  const asked: [number, number][] = [];
  return {
    asked,
    chainId: async () => chainId,
    init: async () => {},
    latest: async () => Math.max(...heights),
    blocks: async (lo: number, hi: number) => { asked.push([lo, hi]); return data.flatMap((d) => d.blocks).filter((b) => b.height >= lo && b.height <= hi); },
    txs: async (lo: number, hi: number) => data.flatMap((d) => d.txs).filter((t) => t.block_height >= lo && t.block_height <= hi),
  } as unknown as GnoSource & { asked: [number, number][] };
}

describe.skipIf(!url)("migration 014: gno messages and GRC20", () => {
  let pool: Pool;
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
  const clean = async () => { for (const ch of [G, R, F]) for (const t of TABLES) await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [ch]); };
  const balances = (chain: string, token: string) =>
    q("SELECT address, balance::text AS balance FROM gno_grc20_balance WHERE chain_id = $1 AND token = $2 ORDER BY address", [chain, token]);

  beforeAll(async () => { pool = createPool(url!); await clean(); });
  afterAll(async () => { await clean(); await pool?.end(); });

  it("writes genesis: block 0, its messages and wugnot, and coverage starts at 0", async () => {
    await commitGno(pool, G, at(0), 0, 0);
    expect(await q("SELECT height::int, extract_version FROM block WHERE chain_id = $1", [G])).toEqual([{ height: 0, extract_version: GNO_EXTRACT_VERSION }]);
    expect(await q("SELECT kind, count(*)::int AS n FROM gno_tx_msg WHERE chain_id = $1 GROUP BY 1 ORDER BY 1", [G]))
      .toEqual([{ kind: "addpkg", n: 89 }, { kind: "call", n: 5 }, { kind: "run", n: 2 }]);
    expect(await q("SELECT token, realm, symbol, decimals, created_height::int FROM gno_grc20_token WHERE chain_id = $1", [G]))
      .toEqual([{ token: WUGNOT, realm: "gno.land/r/gnoland/wugnot", symbol: "wugnot", decimals: 0, created_height: 0 }]);
    for (const cap of ["gno_tx_msg", "gno_grc20"])
      expect(await q("SELECT lo::int, hi::int FROM indexer_coverage($1, $2)", [G, cap])).toEqual([{ lo: 0, hi: 0 }]);
  });

  it("keeps each holder's balance from mints and burns, and a holder is a row", async () => {
    await commitGno(pool, G, at(77259), 77259, null);
    await commitGno(pool, G, at(85424), 85424, null);
    expect(await balances(G, GNS)).toEqual(MINTED.map((address) => ({ address, balance: "50000000000000" })));
    // the unwrap burns what this history never saw minted: a partial history can go negative
    expect(await balances(G, WUGNOT)).toEqual([{ address: "g1pp6rhcqgeag6vd5swugznclk49284kxuhx6qq6", balance: "-2973101272" }]);
    expect(await q("SELECT count(*)::int AS n FROM gno_grc20_transfer WHERE chain_id = $1", [G])).toEqual([{ n: 3 }]);
  });

  it("moves nothing when the same history is written again (a refill)", async () => {
    const before = await q("SELECT address, balance::text, xmin::text FROM gno_grc20_balance WHERE chain_id = $1 ORDER BY 1", [G]);
    const tBefore = await q("SELECT tx_hash, event_index, xmin::text FROM gno_grc20_transfer WHERE chain_id = $1 ORDER BY 1, 2", [G]);
    for (const h of [0, 77259, 85424]) await commitGno(pool, G, at(h), h, null, { cursor: false });
    expect(await q("SELECT address, balance::text, xmin::text FROM gno_grc20_balance WHERE chain_id = $1 ORDER BY 1", [G])).toEqual(before);
    expect(await q("SELECT tx_hash, event_index, xmin::text FROM gno_grc20_transfer WHERE chain_id = $1 ORDER BY 1, 2", [G])).toEqual(tBefore);
    expect(await q("SELECT count(*)::int AS n FROM gno_tx_msg WHERE chain_id = $1", [G])).toEqual([{ n: 96 + 2 + 1 }]);
  });

  it("moves a balance by the difference when an event is read differently, and drops what a transaction no longer yields", async () => {
    const x = at(77259);
    x.transfers[0] = { ...x.transfers[0], amount: "50000000000001" };
    await commitGno(pool, G, x, 77259, null, { cursor: false });
    expect(await balances(G, GNS)).toEqual([
      { address: MINTED[0], balance: "50000000000000" }, { address: MINTED[1], balance: "50000000000001" }]);
    const y = at(77259);
    y.transfers = y.transfers.slice(1);
    await commitGno(pool, G, y, 77259, null, { cursor: false });
    expect(await balances(G, GNS)).toEqual([{ address: MINTED[0], balance: "50000000000000" }]);
  });

  it("takes deleted transfers off, and a balance that reaches zero leaves", async () => {
    await pool.query("DELETE FROM gno_grc20_transfer WHERE chain_id = $1 AND token = $2", [G, GNS]);
    expect(await balances(G, GNS)).toEqual([]);
    await pool.query("DELETE FROM gno_grc20_transfer WHERE chain_id = $1", [G]);
    expect(await q("SELECT count(*)::int AS n FROM gno_grc20_balance WHERE chain_id = $1", [G])).toEqual([{ n: 0 }]);
  });

  it("refills downwards to genesis without touching the cursor, then skips what is current", async () => {
    // A ten-block chain: genesis at 0, GNS's creation moved to height 7, empty blocks between. Its history was
    // written by the previous extractor: version 4, no messages, no tokens.
    const gns = raw(77259);
    const chain = {
      blocks: [...raw(0).blocks, ...[1, 2, 3, 4, 5, 6, 8, 9].map((h) => ({ ...gns.blocks[0], height: h, num_txs: 0 })), { ...gns.blocks[0], height: 7 }],
      txs: [...raw(0).txs, ...gns.txs.map((t) => ({ ...t, block_height: 7 }))],
    };
    const asked: [number, number][] = [];
    const src = {
      chainId: async () => R, init: async () => {},
      blocks: async (lo: number, hi: number) => { asked.push([lo, hi]); return chain.blocks.filter((b) => b.height >= lo && b.height <= hi); },
      txs: async (lo: number, hi: number) => chain.txs.filter((t) => t.block_height >= lo && t.block_height <= hi),
    } as unknown as GnoSource;
    for (let h = 0; h <= 9; h++)
      await pool.query(`INSERT INTO block (chain_id, height, time, tx_count, extract_version) VALUES ($1, $2, now(), 0, 4)`, [R, h]);
    await pool.query(`INSERT INTO indexer_cursor (chain_id, last_height, updated_at, head_height) VALUES ($1, 9, now() - interval '1 hour', 9)`, [R]);
    const target = { chainId: R, graphqlUrl: "http://fake" };

    const r = await gnoRefill(pool, target, { from: 9, floor: 0, batchSize: 4, throttleMs: 0, source: src }, new AbortController().signal);
    expect(r).toEqual({ written: 10, skipped: 0 });
    expect(asked).toEqual([[6, 9], [2, 5], [0, 1]]);
    expect(await q("SELECT extract_version, count(*)::int AS n FROM block WHERE chain_id = $1 GROUP BY 1", [R]))
      .toEqual([{ extract_version: GNO_EXTRACT_VERSION, n: 10 }]);
    expect(await balances(R, GNS)).toEqual(MINTED.map((address) => ({ address, balance: "50000000000000" })));
    expect(await q("SELECT count(*)::int AS n FROM gno_tx_msg WHERE chain_id = $1", [R])).toEqual([{ n: 96 + 2 }]);
    for (const cap of ["gno_tx_msg", "gno_grc20"])
      expect(await q("SELECT lo::int, hi::int FROM indexer_coverage($1, $2)", [R, cap])).toEqual([{ lo: 0, hi: 9 }]);
    expect(await q("SELECT last_height::int, updated_at < now() - interval '30 minutes' AS untouched FROM indexer_cursor WHERE chain_id = $1", [R]))
      .toEqual([{ last_height: 9, untouched: true }]);

    // run again: everything is current, nothing is read
    asked.length = 0;
    const again = await gnoRefill(pool, target, { from: 9, floor: 0, batchSize: 4, throttleMs: 0, source: src }, new AbortController().signal);
    expect(again).toEqual({ written: 0, skipped: 10 });
    expect(asked).toEqual([]);
  });

  it("starts a chain with no cursor at genesis, height 0", async () => {
    const src = fakeSource(F, [0]);
    const n = await gnoOnce(pool, { chainId: F, graphqlUrl: "http://fake" }, src, { batchSize: 1 });
    expect(n).toBe(1);
    expect(src.asked).toEqual([[0, 0]]);
    expect(await q("SELECT last_height::int FROM indexer_cursor WHERE chain_id = $1", [F])).toEqual([{ last_height: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM gno_tx WHERE chain_id = $1 AND height = 0", [F])).toEqual([{ n: 96 }]);
  });
});
