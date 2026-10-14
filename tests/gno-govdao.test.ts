import { describe, expect, test } from "vitest";
import fx from "./fixtures/govdao-render.json";
import { parseProposal, parseProposalList, statusLabel } from "@/lib/gno-govdao";

// The realm's own Render output on gnoland-1, captured 2026-10-14.
describe("GovDAO render parsing", () => {
  test("the list: proposals, authors, status and the page count", () => {
    const { proposals, pages } = parseProposalList(fx.list1);
    expect(pages).toBe(3);
    expect(proposals[0]).toEqual({
      id: 13,
      title: "Set validator Mithrandir to voting power 60",
      author: "@moul",
      status: "accepted",
      statusText: "ACCEPTED",
      tiers: ["T1", "T2", "T3"],
    });
    expect(proposals.find((p) => p.id === 12)?.author).toBe("g1ecsuj0q572jr0dhu29q9njtnmw03hyu7tyyvv6");
    expect(proposals.find((p) => p.id === 10)?.status).toBe("active");
    const last = parseProposalList(fx.list3).proposals;
    expect(last.map((p) => p.id)).toContain(0);
    expect(last.find((p) => p.id === 3)?.title).toBe("Set the run_submitters allowlist");
  });

  test("a proposal: body, executor, tally and voters", () => {
    const p = parseProposal(13, fx.prop13, fx.prop13votes)!;
    expect(p.title).toBe("Set validator Mithrandir to voting power 60");
    expect(p.status).toBe("accepted");
    expect(p.executor).toBe("gno.land/r/sys/validators/v0");
    expect(p.body).toMatch(/^Upsert operator g1ecsuj0q572jr0dhu29q9njtnmw03hyu7tyyvv6/);
    expect(p.body).not.toMatch(/Executor created in|Stats|---\s*$/);
    expect(p.yes).toBeCloseTo(66.67, 1);
    expect(p.no).toBe(0);
    expect(p.voters).toEqual([
      { option: "YES", tier: "T1", voter: "g1ecsuj0q572jr0dhu29q9njtnmw03hyu7tyyvv6" },
      { option: "YES", tier: "T1", voter: "@moul" },
    ]);
    expect(parseProposal(10, fx.prop10, null)?.status).toBe("active");
    expect(parseProposal(9, fx.prop10, null)).toBeNull();
  });

  test("labels", () => {
    expect(statusLabel("accepted", "")).toBe("Passed");
    expect(statusLabel("active", "")).toBe("Voting");
  });
});
