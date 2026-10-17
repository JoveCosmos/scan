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

  test("holders are ranked on the numeric balance, not its text", async () => {
    const holders = await data.tokenHolders(chain, "gno.land/r/gnoswap/gns.GNS.0000000");
    expect(holders).toEqual([{ address: "g1pool", balance: BigInt("30585601489055") }]);
    const q = queries.find((x) => x.text.includes("FROM gno_grc20_balance") && x.text.includes("token = $2"))!;
    expect(q.text).toMatch(/ORDER BY gno_grc20_balance\.balance DESC/);
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
