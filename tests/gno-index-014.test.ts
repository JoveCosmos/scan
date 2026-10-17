import { beforeEach, describe, expect, test } from "vitest";
import { clearCache } from "@/lib/cache";

/**
 * Migration 014's reads: used only once gno_tx_msg / gno_grc20 coverage
 * reaches genesis. A fake pool answers indexer_coverage from `caps` and each
 * table read by its text.
 */
const queries: { text: string; params: unknown[] }[] = [];
let caps: Record<string, { lo: string; hi: string } | null> = {};
const pool = {
  query: async (text: string, params: unknown[]) => {
    queries.push({ text, params });
    if (text.includes("indexer_coverage")) {
      const c = caps[String(params[1])];
      return { rows: c ? [{ lo: c.lo, hi: c.hi, lo_time: "t0", hi_time: "t1" }] : [] };
    }
    if (text.includes("GROUP BY pkg_path"))
      return {
        rows: [
          { name: "gno.land/r/gnoswap/router", calls: 3988, last_height: "857000", last_time: "2026-10-17 21:00:00+00" },
          { name: "gno.land/r/gnoland/blog", calls: 137, last_height: "800000", last_time: null },
        ],
      };
    if (text.includes("GROUP BY func"))
      return { rows: [{ name: "SwapRoute", calls: 3000, last_height: "857000", last_time: "2026-10-17 21:00:00+00" }] };
    if (text.includes("interval '24 hours'"))
      return { rows: [{ token: "gno.land/r/gnoswap/gns.GNS.0000000", transfers: 1323 }] };
    if (text.includes("g.token = $2"))
      return { rows: [{ day: "2026-10-16", transfers: 410 }, { day: "2026-10-17", transfers: 380 }] };
    if (text.includes("FROM gno_grc20_token t"))
      return {
        rows: [
          { token: "gno.land/r/gnoswap/gns.GNS.0000000", realm: "gno.land/r/gnoswap/gns", name: "Gnoswap", symbol: "GNS", decimals: 6, created_height: "77259", created_tx: "AA", holders: "565", supply: "118737756333652" },
          { token: "gno.land/r/gnoland/wugnot.wugnot.0000000", realm: "gno.land/r/gnoland/wugnot", name: "wrapped GNOT", symbol: "wugnot", decimals: 0, created_height: "0", created_tx: "BB", holders: "183", supply: "5558432268709" },
        ],
      };
    if (text.includes("count(*)::text AS transfers")) return { rows: [{ token: "gno.land/r/gnoswap/gns.GNS.0000000", transfers: "56372" }] };
    if (text.includes("FROM gno_grc20_balance") && text.includes("token = $2"))
      return { rows: [{ address: "g1pool", balance: "30585601489055" }] };
    if (text.includes("kind IN ('enable', 'reject')"))
      return {
        rows: [
          { kind: "reject", caller: "g1gov", height: "820000", tx_hash: "D2", success: false, time: null },
          { kind: "enable", caller: "g1gov", height: "810000", tx_hash: "D1", success: true, time: "2026-10-01 10:00:00+00" },
        ],
      };
    if (text.includes("GROUP BY caller"))
      return { rows: [{ caller: "g1bot", calls: 9000, last_height: "856000" }, { caller: "g1x", calls: 12, last_height: "800000" }] };
    if (text.includes("m.caller = $2"))
      return {
        rows: Array.from({ length: Number(params[2]) }, (_, i) => ({
          tx_hash: `E${i.toString(16).toUpperCase()}`, msg_index: i % 2, height: String(5000 - i), success: i !== 1,
          kind: i === 0 ? "run" : "call", pkg_path: i === 0 ? null : "gno.land/r/demo/boards", func: i === 0 ? null : "CreateThread", args: null, time: null,
        })),
      };
    if (text.includes("FROM gno_grc20_transfer") && text.includes("token = $2"))
      return {
        rows: Array.from({ length: Number(params[2]) }, (_, i) => ({
          height: String(700 - i), tx_hash: `A${i.toString(16).toUpperCase()}`, event_index: 3, from_addr: i === 0 ? "" : "g1a", to_addr: "g1b", amount: "1000000",
        })),
      };
    if (text.includes("count(*) FILTER (WHERE m.kind = 'call')"))
      return { rows: [{ day: "2026-10-15", calls: 900, packages: 2 }, { day: "2026-10-16", calls: 1200, packages: 0 }] };
    if (text.includes("FROM gno_grc20_transfer g"))
      return { rows: [{ day: "2026-10-14", transfers: 40 }, { day: "2026-10-16", transfers: 310 }] };
    if (text.includes("FROM block") && text.includes("time >="))
      return { rows: [{ h: "700000" }] };
    if (text.includes("count(DISTINCT caller)")) return { rows: [{ total: 13215, callers: 41 }] };
    if (text.includes("FROM gno_tx_msg m") && text.includes("kind = 'call'"))
      return {
        rows: Array.from({ length: Number(params[2]) }, (_, i) => ({
          tx_hash: `F${i.toString(16).toUpperCase()}`, msg_index: 0, height: String(900 - i), success: true, func: "Heartbeat", caller: "g1x", args: ["1"], time: null,
        })),
      };
    if (text.includes("DISTINCT ON (m.pkg_path)"))
      return { rows: [{ pkg_path: "gno.land/r/gov/dao", caller: "g1gov", height: "0", tx_hash: "CC", time: null }] };
    return { rows: [] };
  },
};
(globalThis as Record<symbol, unknown>)[Symbol.for("gata.indexerPool")] = pool;

const { getChain } = await import("@/lib/chains");
const index = await import("@/lib/gno-index");
const data = await import("@/lib/gno-token-data");
const packages = await import("@/lib/gno-packages");
const stats = await import("@/lib/stats");
const chain = getChain("gnoland-1")!;

beforeEach(() => {
  clearCache();
  queries.length = 0;
  caps = {};
});

describe("gnoIndexed", () => {
  test("only once coverage starts at genesis, and only on gno chains", async () => {
    expect(await index.gnoIndexed("gnoland-1", "gno_grc20")).toBeNull();
    caps.gno_grc20 = { lo: "720000", hi: "856783" };
    clearCache();
    expect(await index.gnoIndexed("gnoland-1", "gno_grc20")).toBeNull();
    caps.gno_grc20 = { lo: "0", hi: "856783" };
    clearCache();
    expect(await index.gnoIndexed("gnoland-1", "gno_grc20")).toBe(pool);
    expect(await index.gnoIndexed("atomone-1", "gno_grc20")).toBeNull();
  });
});

describe("tokens from the index", () => {
  beforeEach(() => {
    caps.gno_grc20 = { lo: "0", hi: "856783" };
  });

  test("the list carries holders, supply and transfers; a genesis token has no creating tx", async () => {
    const list = (await data.tokenList(chain))!;
    const gns = list.find((t) => t.symbol === "GNS")!;
    expect(gns).toMatchObject({ holders: 565, transfers: 56372, decimals: 6, createdTx: "AA" });
    expect(gns.supply).toBe(BigInt("118737756333652"));
    expect(list.find((t) => t.symbol === "wugnot")).toMatchObject({ createdTx: null, transfers: 0 });
  });

  test("holders are ranked on the numeric balance, not its text, and paged by keyset", async () => {
    const page = await data.tokenHoldersPage(chain, "gno.land/r/gnoswap/gns.GNS.0000000");
    expect(page).toEqual({ holders: [{ rank: 1, address: "g1pool", balance: BigInt("30585601489055") }], next: null });
    const q = queries.find((x) => x.text.includes("FROM gno_grc20_balance") && x.text.includes("token = $2"))!;
    expect(q.text).toMatch(/ORDER BY gno_grc20_balance\.balance DESC, address DESC/);
    expect(await data.tokenHoldersPage(chain, "gno.land/r/gnoswap/gns.GNS.0000000", "not-a-cursor")).toBeNull();
  });
});

describe("realm calls and deployers from the index", () => {
  beforeEach(() => {
    caps.gno_tx_msg = { lo: "0", hi: "856783" };
  });

  test("the newest page, the counts and a keyset cursor for the next", async () => {
    const r = (await packages.gnoRealmCalls(chain, "gno.land/r/x/bubblerumble4"))!;
    expect(r.total).toBe(13215);
    expect(r.callers).toBe(41);
    expect(r.calls).toHaveLength(100);
    expect(r.calls[0]).toMatchObject({ func: "Heartbeat", args: ["1"], height: 900 });
    expect(r.next).toBe("k:801:F63:0");
    expect(index.parseCallCursor(r.next!)).toEqual({ height: 801, txHash: "F63", msgIndex: 0 });
  });

  test("deployers, one query for every package", async () => {
    const d = await packages.gnoDeploys(chain);
    expect(d?.get("gno.land/r/gov/dao")).toMatchObject({ creator: "g1gov", height: 0, txHash: "CC" });
  });
});

describe("approvals, callers and an account's calls", () => {
  beforeEach(() => {
    caps.gno_tx_msg = { lo: "0", hi: "856783" };
  });

  test("approvals and rejections, newest first, failed ones kept for the caller to drop", async () => {
    const a = await index.indexedApprovals(pool as never, "gnoland-1", "gno.land/r/x/y");
    expect(a).toEqual([
      { kind: "reject", by: "g1gov", height: 820000, txHash: "D2", success: false, time: null },
      { kind: "enable", by: "g1gov", height: 810000, txHash: "D1", success: true, time: "2026-10-01 10:00:00+00" },
    ]);
  });

  test("top callers, busiest first", async () => {
    const c = await index.indexedTopCallers(pool as never, "gnoland-1", "gno.land/r/x/y");
    expect(c).toEqual([
      { caller: "g1bot", calls: 9000, lastHeight: 856000 },
      { caller: "g1x", calls: 12, lastHeight: 800000 },
    ]);
    expect(queries.at(-1)!.text).toMatch(/ORDER BY count\(\*\) DESC, caller ASC/);
  });

  test("an account's calls and runs page by keyset", async () => {
    const first = await index.indexedAccountCalls(pool as never, "gnoland-1", "g1me", 100);
    expect(first.calls).toHaveLength(100);
    expect(first.calls[0]).toMatchObject({ kind: "run", pkgPath: null, func: "", height: 5000 });
    expect(first.calls[1]).toMatchObject({ kind: "call", pkgPath: "gno.land/r/demo/boards", func: "CreateThread", success: false });
    expect(first.next).toBe("k:4901:E63:1");
    const cursor = index.parseCallCursor(first.next!)!;
    await index.indexedAccountCalls(pool as never, "gnoland-1", "g1me", 100, cursor);
    const q = queries.at(-1)!;
    expect(q.text).toMatch(/\(m\.height, m\.tx_hash, m\.msg_index\) < \(\$4, \$5, \$6\)/);
    expect(q.params.slice(3)).toEqual([4901, "E63", 1]);
  });
});

describe("a token's transfers, paged", () => {
  beforeEach(() => {
    caps.gno_grc20 = { lo: "0", hi: "856783" };
  });

  test("the newest page, a mint's empty sender, and a cursor below it", async () => {
    const page = (await data.tokenTransfersPage(chain, "gno.land/r/gnoswap/gns.GNS.0000000"))!;
    expect(page.transfers).toHaveLength(100);
    expect(page.transfers[0]).toMatchObject({ from: "", to: "g1b", height: 700, amount: BigInt(1000000) });
    expect(page.next).toBe("k:601:A63:3");
    await data.tokenTransfersPage(chain, "gno.land/r/gnoswap/gns.GNS.0000000", page.next!);
    const q = queries.at(-1)!;
    expect(q.text).toMatch(/ORDER BY gno_grc20_transfer\.height DESC/);
    expect(q.params.slice(3)).toEqual([601, "A63", 3]);
    expect(await data.tokenTransfersPage(chain, "gno.land/r/gnoswap/gns.GNS.0000000", "k:1:zz:0")).toBeNull();
  });

  test("nothing until the index covers genesis", async () => {
    caps.gno_grc20 = { lo: "500000", hi: "856783" };
    expect(await data.tokenTransfersPage(chain, "gno.land/r/gnoswap/gns.GNS.0000000")).toBeNull();
  });
});

describe("gno.land charts from the index", () => {
  test("realm calls, token transfers and packages per day, from 90 days back", async () => {
    caps.gno_tx_msg = { lo: "0", hi: "856783" };
    caps.gno_grc20 = { lo: "0", hi: "856783" };
    expect(await stats.gnoDailyIndexed(chain)).toEqual([
      { day: "2026-10-14", calls: 0, transfers: 40, packages: 0 },
      { day: "2026-10-15", calls: 900, transfers: 0, packages: 2 },
      { day: "2026-10-16", calls: 1200, transfers: 310, packages: 0 },
    ]);
    const reads = queries.filter((q) => q.text.includes("gno_tx_msg m") || q.text.includes("gno_grc20_transfer g"));
    expect(reads.map((q) => q.params[1])).toEqual([700000, 700000]);
  });

  test("none while either is short of genesis", async () => {
    caps.gno_tx_msg = { lo: "0", hi: "856783" };
    caps.gno_grc20 = { lo: "1", hi: "856783" };
    expect(await stats.gnoDailyIndexed(chain)).toBeNull();
  });
});

describe("call counts and token activity", () => {
  beforeEach(() => {
    caps.gno_tx_msg = { lo: "0", hi: "856783" };
    caps.gno_grc20 = { lo: "0", hi: "856783" };
  });

  test("every realm's calls and last call, and one realm's per function", async () => {
    const realms = await index.indexedRealmCallCounts(pool as never, "gnoland-1");
    expect(realms.get("gno.land/r/gnoswap/router")).toEqual({ calls: 3988, lastHeight: 857000, lastTime: "2026-10-17 21:00:00+00" });
    expect(realms.get("gno.land/r/gnoland/blog")?.lastTime).toBeNull();
    const q = queries.find((x) => x.text.includes("GROUP BY pkg_path"))!;
    expect(q.text).toMatch(/kind = 'call'/);
    const funcs = await index.indexedFunctionCallCounts(pool as never, "gnoland-1", "gno.land/r/gnoswap/router");
    expect(funcs.get("SwapRoute")?.calls).toBe(3000);
    expect(queries.find((x) => x.text.includes("GROUP BY func"))!.params).toEqual(["gnoland-1", "gno.land/r/gnoswap/router"]);
  });

  test("a token's transfers in 24 hours and per day, bounded by height", async () => {
    const recent = (await data.tokenTransfers24h(chain))!;
    expect(recent.get("gno.land/r/gnoswap/gns.GNS.0000000")).toBe(1323);
    expect(queries.find((x) => x.text.includes("interval '24 hours'"))!.params).toEqual(["gnoland-1", 700000]);
    const daily = await data.tokenDailyTransfers(chain, "gno.land/r/gnoswap/gns.GNS.0000000");
    expect(daily).toEqual([{ day: "2026-10-16", transfers: 410 }, { day: "2026-10-17", transfers: 380 }]);
    expect(queries.find((x) => x.text.includes("g.token = $2"))!.params).toEqual([
      "gnoland-1",
      "gno.land/r/gnoswap/gns.GNS.0000000",
      700000,
    ]);
  });

  test("none until the index covers genesis", async () => {
    caps.gno_grc20 = { lo: "9", hi: "856783" };
    expect(await data.tokenTransfers24h(chain)).toBeNull();
    expect(await data.tokenDailyTransfers(chain, "gno.land/r/gnoswap/gns.GNS.0000000")).toBeNull();
  });
});
