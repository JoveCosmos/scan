import { beforeEach, describe, expect, test } from "vitest";
import { clearCache } from "@/lib/cache";

/**
 * Migration 013's reads switch on their capabilities and keep the old query
 * until then. A fake pool stands in for Postgres: it answers indexer_coverage
 * from `caps` and records every query.
 */
const queries: string[] = [];
let caps: Record<string, { lo: string; hi: string }> = {};
const pool = {
  query: async (text: string, params: unknown[]) => {
    queries.push(text);
    if (text.includes("indexer_coverage")) {
      const c = caps[String(params[1])];
      return { rows: c ? [{ lo: c.lo, hi: c.hi, lo_time: "2026-01-01 00:00:00+00", hi_time: "2026-10-16 00:00:00+00" }] : [] };
    }
    if (text.includes("proposer_blocks")) return { rows: [{ proposed: "913000", last_height: "10838000", last_time: "t" }] };
    if (text.includes("FROM block")) return { rows: [{ proposed: "5", last_height: "9", last_time: "t" }] };
    if (text.includes("FROM transfer")) return { rows: [{ denom: "uatone", total: "100", n: "3", first: "a", last: "b" }] };
    return { rows: [] };
  },
};
(globalThis as Record<symbol, unknown>)[Symbol.for("gata.indexerPool")] = pool;

const db = await import("@/lib/indexer-db");

beforeEach(() => {
  clearCache();
  queries.length = 0;
  caps = { blocks: { lo: "1", hi: "10838424" } };
});

describe("proposerStats", () => {
  test("counts from the block index until the rollup exists; the chain's blocks need no count", async () => {
    const s = await db.proposerStats("atomone-1", "AB");
    expect(s).toMatchObject({ proposed: 5, totalBlocks: 10838424, fromGenesis: true });
    expect(queries.some((q) => q.includes("proposer_blocks"))).toBe(false);
    expect(queries.some((q) => /count\(\*\)::text AS n FROM block/.test(q))).toBe(false);
  });

  test("reads proposer_blocks() once proposer_count is covered", async () => {
    caps.proposer_count = { lo: "1", hi: "10838424" };
    const s = await db.proposerStats("atomone-1", "AB");
    expect(s).toMatchObject({ proposed: 913000, lastHeight: 10838000 });
    expect(queries.some((q) => q.includes("FROM proposer_blocks($1, $2, $3, $4)"))).toBe(true);
  });
});

describe("commissionEarned", () => {
  test("joins tx on its signer until transfer.signer is covered", async () => {
    await db.commissionEarned("atomone-1", "atone1x");
    expect(queries.find((q) => q.includes("FROM transfer"))).toMatch(/JOIN tx x/);
  });

  test("reads the signer column once commission_signer is covered", async () => {
    caps.commission_signer = { lo: "1", hi: "10838424" };
    const e = await db.commissionEarned("atomone-1", "atone1y");
    const q = queries.find((x) => x.includes("FROM transfer"))!;
    expect(q).not.toMatch(/JOIN/);
    expect(q).toMatch(/signer = \$2/);
    expect(e?.withdrawals).toBe(3);
  });
});
