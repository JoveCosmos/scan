import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("@/lib/indexer-db", () => ({
  indexerPool: () => ({ query }),
  poolFor: () => ({ query }),
}));
vi.mock("@/lib/indexer-coverage", () => ({
  coverageOf: vi.fn(async () => ({ lo: 1, hi: 400000, loTime: null, hiTime: null })),
}));

import { gnoPartyPage, parseGnoCursor, addressTxCount } from "@/lib/indexer-tx";

beforeEach(() => query.mockReset());

describe("gno history from gno_tx_party", () => {
  it("parses only well-formed g4 cursors", () => {
    expect(parseGnoCursor("g4:335885:abcdef12")).toEqual({ height: 335885, hash: "ABCDEF12" });
    expect(parseGnoCursor("p:10")).toBeNull();
    expect(parseGnoCursor(null)).toBeNull();
  });

  it("walks the primary key newest first and hands back a keyset cursor", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      height: String(300 - i),
      tx_hash: `H${i}`,
      roles: 1,
      time: "2026-09-26 00:00:00+00",
      success: true,
    }));
    query.mockResolvedValueOnce({ rows });
    const page = await gnoPartyPage("gnoland-1", "g1abc", "g4:301:FF", 2);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM gno_tx_party p\s+JOIN gno_tx t/);
    expect(sql).toMatch(/\(p\.height, p\.tx_hash\) < \(\$6, \$7\)/);
    expect(sql).toMatch(/ORDER BY p\.height DESC, p\.tx_hash DESC/);
    expect(params).toEqual(["gnoland-1", "g1abc", 1, 400000, 3, 301, "FF"]);
    expect(page?.rows).toHaveLength(2);
    expect(page?.next).toBe("g4:299:H1");
  });

  it("ends paging when the page is not full", async () => {
    query.mockResolvedValueOnce({
      rows: [{ height: "5", tx_hash: "A", roles: 8, time: null, success: false }],
    });
    const page = await gnoPartyPage("gnoland-1", "g1abc", null, 50);
    expect(page?.next).toBeNull();
    expect(query.mock.calls[0][1]).toHaveLength(5);
  });

  it("returns null rather than failing when the query errors", async () => {
    query.mockRejectedValueOnce(new Error("relation does not exist"));
    expect(await gnoPartyPage("gnoland-1", "g1abc", null)).toBeNull();
  });
});

describe("address_tx_count", () => {
  it("is exact when coverage starts at the first block", async () => {
    query.mockResolvedValueOnce({
      rows: [{ tx_count: "32003", first_height: "10", last_height: "336000", first_time: null, last_time: null }],
    });
    const c = await addressTxCount("gnoland-1", "g1juss", 1);
    expect(c).toMatchObject({ count: 32003, exact: true, first: { height: 10 }, last: { height: 336000 } });
  });

  it("is a lower bound while coverage has not reached genesis", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const c = await addressTxCount("atomone-1", "atone1x", 0);
    expect(c).toMatchObject({ count: 0, exact: false, since: { height: 1 } });
  });
});
