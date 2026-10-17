import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearCache } from "@/lib/cache";

/**
 * GovDAO's dates: creation from the tx-indexer's ProposalCreated events, votes
 * and executions from realm calls in our index. Shaped on gnoland-1's
 * proposal 13: created by a script, voted by one member's call (the other
 * voted from the script) and executed by a call.
 */
const hash = (n: number) => Buffer.alloc(32, n).toString("base64");
const hex = (n: number) => Buffer.alloc(32, n).toString("hex").toUpperCase();

vi.mock("@/lib/gno", async (orig) => ({
  ...(await orig<typeof import("@/lib/gno")>()),
  gql: vi.fn(async (_chain: unknown, query: string) => {
    if (query.includes("ProposalCreated"))
      return {
        getTransactions: [
          {
            hash: hash(1),
            block_height: 720843,
            response: {
              events: [
                { type: "ProposalCreated", pkg_path: "gno.land/r/gov/dao", attrs: [{ key: "id", value: "13" }] },
                // Another realm's event of the same name is not GovDAO's.
                { type: "ProposalCreated", pkg_path: "gno.land/r/other/dao", attrs: [{ key: "id", value: "14" }] },
              ],
            },
          },
        ],
      };
    if (query.includes("getBlocks")) return { getBlocks: [{ time: "2026-09-30T10:00:00Z" }] };
    return {};
  }),
}));

let caps: Record<string, { lo: string; hi: string }> = {};
const queries: { text: string; params: unknown[] }[] = [];
const pool = {
  query: async (text: string, params: unknown[]) => {
    queries.push({ text, params });
    if (text.includes("indexer_coverage")) {
      const c = caps[String(params[1])];
      return { rows: c ? [{ lo: c.lo, hi: c.hi, lo_time: "t0", hi_time: "t1" }] : [] };
    }
    if (text.includes("m.func = ANY($3::text[])"))
      return {
        rows: [
          { func: "MustVoteOnProposalSimple", caller: "g1ecsuj0q572jr0dhu29q9njtnmw03hyu7tyyvv6", args: ["13", "no"], height: "741000", tx_hash: hex(2), time: "2026-10-01 08:00:00+00" },
          { func: "MustVoteOnProposalSimple", caller: "g1ecsuj0q572jr0dhu29q9njtnmw03hyu7tyyvv6", args: ["13", "YES"], height: "741835", tx_hash: hex(3), time: "2026-10-01 09:00:00+00" },
          { func: "ExecuteProposal", caller: "g1leu8d2vsplhehcfkjg50mwgdpxdkt8tztu95wr", args: ["13"], height: "741860", tx_hash: hex(4), time: "2026-10-01 09:02:00+00" },
          { func: "ExecuteProposal", caller: "g1x", args: ["13"], height: "741900", tx_hash: hex(5), time: "2026-10-01 09:05:00+00" },
          { func: "ExecuteProposal", caller: "g1x", args: ["99"], height: "741950", tx_hash: hex(6), time: null },
        ],
      };
    if (text.includes("FROM gno_tx WHERE")) return { rows: [] };
    return { rows: [] };
  },
};
(globalThis as Record<symbol, unknown>)[Symbol.for("gata.indexerPool")] = pool;

const { getChain } = await import("@/lib/chains");
const { govdaoTimeline } = await import("@/lib/gno-govdao");
const chain = getChain("gnoland-1")!;

beforeEach(() => {
  clearCache();
  queries.length = 0;
  caps = { gno_tx_msg: { lo: "0", hi: "857000" }, gno_tx: { lo: "0", hi: "857000" } };
});

describe("GovDAO timeline", () => {
  test("created from the event, a member's last vote and the first execution from the index", async () => {
    const t = (await govdaoTimeline(chain))!;
    expect([...t.keys()]).toEqual([13]);
    const p = t.get(13)!;
    // No time in the index for the creating transaction: the block's, from the tx-indexer.
    expect(p.created).toEqual({ height: 720843, txHash: hex(1), time: "2026-09-30T10:00:00Z" });
    expect(p.executed).toEqual({ height: 741860, txHash: hex(4), time: "2026-10-01 09:02:00+00" });
    expect(p.votes.get("g1ecsuj0q572jr0dhu29q9njtnmw03hyu7tyyvv6")).toEqual({
      height: 741835,
      txHash: hex(3),
      time: "2026-10-01 09:00:00+00",
      option: "YES",
    });
    const calls = queries.find((q) => q.text.includes("m.func = ANY"))!;
    expect(calls.params).toEqual([
      "gnoland-1",
      "gno.land/r/gov/dao",
      ["ExecuteProposal", "ExecuteOrRejectProposal", "MustVoteOnProposalSimple"],
    ]);
  });

  test("without the index, creation still; no votes or executions", async () => {
    caps.gno_tx_msg = { lo: "500000", hi: "857000" };
    const p = (await govdaoTimeline(chain))!.get(13)!;
    expect(p.created.height).toBe(720843);
    expect(p.executed).toBeNull();
    expect(p.votes.size).toBe(0);
  });
});
