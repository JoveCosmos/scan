import { describe, expect, it } from "vitest";
import {
  dailySeries,
  earlierVotes,
  formatDuration,
  jailSpells,
  longestRun,
  missRuns,
  netStakeFlow,
  reliability,
} from "@/lib/signing-stats";

describe("missRuns / longestRun", () => {
  it("groups consecutive heights, newest first, ignoring order and repeats", () => {
    const runs = missRuns([105, 101, 102, 103, 110, 103, 111]);
    expect(runs).toEqual([
      { from: 110, to: 111, length: 2 },
      { from: 105, to: 105, length: 1 },
      { from: 101, to: 103, length: 3 },
    ]);
    expect(longestRun(runs)).toEqual({ from: 101, to: 103, length: 3 });
  });

  it("prefers the newest of equally long runs, and null for none", () => {
    expect(longestRun(missRuns([1, 2, 10, 11]))).toEqual({ from: 10, to: 11, length: 2 });
    expect(longestRun([])).toBeNull();
  });
});

describe("reliability", () => {
  it("is the signed share of blocks", () => {
    expect(reliability(10_000, 7)).toBeCloseTo(0.9993);
    expect(reliability(100, 0)).toBe(1);
  });
  it("refuses empty or inconsistent windows", () => {
    expect(reliability(0, 0)).toBeNull();
    expect(reliability(10, 11)).toBeNull();
    expect(reliability(10, -1)).toBeNull();
  });
});

describe("dailySeries", () => {
  it("fills every UTC day with zeros, oldest first, ending today", () => {
    const s = dailySeries([{ day: "2026-09-25", missed: 4 }], 3, new Date("2026-09-26T12:00:00Z"));
    expect(s).toEqual([
      { day: "2026-09-24", missed: 0 },
      { day: "2026-09-25", missed: 4 },
      { day: "2026-09-26", missed: 0 },
    ]);
  });
});

describe("jailSpells", () => {
  it("pairs each jailing with the unjail that ended it, newest first", () => {
    const spells = jailSpells([
      { kind: "jailed", height: 100, time: "2026-01-01T00:00:00Z" },
      { kind: "unjailed", height: 200, time: "2026-01-01T06:30:00Z" },
      { kind: "jailed", height: 300, time: "2026-02-01T00:00:00Z" },
    ]);
    expect(spells).toHaveLength(2);
    expect(spells[0].jailedAt.height).toBe(300);
    expect(spells[0].unjailedAt).toBeNull();
    expect(spells[1].downtimeMs).toBe(6.5 * 3_600_000);
    expect(formatDuration(spells[1].downtimeMs)).toBe("6h 30m");
  });

  it("ignores an unjail with no jailing before it", () => {
    expect(jailSpells([{ kind: "unjailed", height: 5, time: "2026-01-01T00:00:00Z" }])).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("reads at a glance", () => {
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(formatDuration(42 * 60_000)).toBe("42m");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("earlierVotes", () => {
  it("keeps only voters who changed, collapsing repeats of the same option", () => {
    const v = (voter: string, option: string, height: number) => ({
      voter,
      proposalId: 7,
      option,
      height,
      time: `2026-01-01T00:00:${String(height).padStart(2, "0")}Z`,
      txHash: `T${height}`,
    });
    const m = earlierVotes([
      v("a", "YES", 3),
      v("a", "NO", 5),
      v("a", "NO", 6),
      v("b", "YES", 4),
      v("c", "ABSTAIN", 1),
      v("c", "ABSTAIN", 2),
    ]);
    expect(m.get("7:a")).toEqual(["YES"]);
    expect(m.has("7:b")).toBe(false);
    expect(m.has("7:c")).toBe(false);
  });
});

describe("netStakeFlow", () => {
  const op = "valoper1x";
  const t = "2026-09-20T00:00:00Z";
  it("adds delegations and incoming redelegations, subtracts the rest", () => {
    const net = netStakeFlow(
      [
        { kind: "delegate", validator: op, validatorDst: null, amount: "100", time: t },
        { kind: "undelegate", validator: op, validatorDst: null, amount: "30", time: t },
        { kind: "redelegate", validator: op, validatorDst: "valoper1y", amount: "20", time: t },
        { kind: "redelegate", validator: "valoper1z", validatorDst: op, amount: "5", time: t },
        { kind: "edit_validator", validator: op, validatorDst: null, amount: null, time: t },
        { kind: "delegate", validator: op, validatorDst: null, amount: "999", time: "2020-01-01T00:00:00Z" },
      ],
      op,
      Date.parse("2026-09-01T00:00:00Z")
    );
    expect(net.toString()).toBe("55");
  });
});
