import { beforeEach, describe, expect, it, vi } from "vitest";

type Q = { text: string; params: unknown[] };
const queries: Q[] = [];
let respond: (text: string, params: unknown[]) => unknown[] = () => [];
let poolPresent = true;

vi.mock("@/lib/cache", () => ({
  cached: async (_k: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
}));

vi.mock("@/lib/indexer-db", () => ({
  poolFor: () =>
    poolPresent
      ? {
          query: async (text: string, params: unknown[]) => {
            queries.push({ text, params });
            const rows = respond(text, params);
            if (rows instanceof Error) throw rows;
            return { rows };
          },
        }
      : null,
  coverage: async () => null,
}));

const cov = { lo: 1000, hi: 2000, loTime: "2026-06-01T00:00:00Z", hiTime: "2026-09-26T00:00:00Z" };
let coverageFor: Record<string, typeof cov | null> = {};
vi.mock("@/lib/indexer-coverage", () => ({
  coverageOf: async (_chain: string, cap: string) => coverageFor[cap] ?? null,
  indexerHealth: async () => ({ stale: true, lag: 5, updatedAt: null }),
}));

const mod = await import("@/lib/indexer-validator");

beforeEach(() => {
  queries.length = 0;
  respond = () => [];
  poolPresent = true;
  coverageFor = {};
});

describe("signingCoverage", () => {
  it("uses the capability when the indexer reports it", async () => {
    coverageFor.missed_signatures = cov;
    expect(await mod.signingCoverage("atomone-1")).toEqual(cov);
    expect(queries).toHaveLength(0);
  });

  it("falls back to the version-3 block run before the v4 deploy", async () => {
    respond = (text) => {
      if (text === mod.SQL.v3Coverage) return [{ lo: "1500", hi: "2000" }];
      if (text === mod.SQL.blockTimes)
        return [
          { height: "1500", time: "2026-07-01T00:00:00Z" },
          { height: "2000", time: "2026-09-26T00:00:00Z" },
        ];
      return [];
    };
    const c = await mod.signingCoverage("atomone-1");
    expect(c).toEqual({ lo: 1500, hi: 2000, loTime: "2026-07-01T00:00:00Z", hiTime: "2026-09-26T00:00:00Z" });
    expect(queries[0].params).toEqual(["atomone-1"]);
  });

  it("is null with no pool or a failing query", async () => {
    poolPresent = false;
    expect(await mod.signingCoverage("x")).toBeNull();
    poolPresent = true;
    respond = () => new Error("function indexer_coverage does not exist") as unknown as unknown[];
    expect(await mod.signingCoverage("x")).toBeNull();
  });
});

describe("signingHistory", () => {
  it("reads counts, days and runs in the covered range with the upper-cased key", async () => {
    coverageFor.missed_signatures = cov;
    respond = (text) => {
      if (text === mod.SQL.firstHeightSince) return [{ h: "1200" }];
      if (text === mod.SQL.missedCounts) return [{ d30: 3, d90: 3, total: 9, nil: 1 }];
      if (text === mod.SQL.missedDaily) return [{ day: "2026-09-20", missed: 3 }];
      if (text === mod.SQL.missedRuns)
        return [
          { lo: "1900", hi: "1902", n: 3, tag: "recent" },
          { lo: "1100", hi: "1105", n: 6, tag: "longest" },
        ];
      return [];
    };
    const h = await mod.signingHistory("atomone-1", "abcdef");
    expect(h).not.toBeNull();
    expect(h!.all).toEqual({ blocks: 1001, missed: 9, ratio: 1 - 9 / 1001 });
    expect(h!.d30).toEqual({ blocks: 801, missed: 3, ratio: 1 - 3 / 801 });
    expect(h!.longest).toEqual({ from: 1100, to: 1105, length: 6 });
    expect(h!.recent).toEqual([{ from: 1900, to: 1902, length: 3 }]);
    expect(h!.nil).toBe(1);
    const counts = queries.find((q) => q.text === mod.SQL.missedCounts)!;
    expect(counts.params).toEqual(["atomone-1", "ABCDEF", 1200, 1200, 1000, 2000]);
  });

  it("is null when nothing is covered", async () => {
    respond = () => [];
    expect(await mod.signingHistory("atomone-1", "AB")).toBeNull();
  });
});

describe("missedLast30d", () => {
  it("returns misses by upper-case key when coverage spans 30 days", async () => {
    coverageFor.missed_signatures = cov;
    respond = (text) => {
      if (text === mod.SQL.firstHeightSince) return [{ h: "1500" }];
      if (text === mod.SQL.missedBySet) return [{ cons_addr: "aa11", n: 4 }];
      return [];
    };
    const m = await mod.missedLast30d("atomone-1");
    expect(m?.get("AA11")).toBe(4);
    expect(queries.find((q) => q.text === mod.SQL.missedBySet)!.params).toEqual(["atomone-1", 1500, 2000]);
  });

  it("is null when coverage starts inside the 30 days", async () => {
    coverageFor.missed_signatures = cov;
    respond = (text) => (text === mod.SQL.firstHeightSince ? [{ h: "900" }] : []);
    expect(await mod.missedLast30d("atomone-1")).toBeNull();
  });
});

describe("absentAt", () => {
  it("returns only absent keys inside coverage, null outside", async () => {
    coverageFor.missed_signatures = cov;
    respond = () => [
      { cons_addr: "aa", flag: "absent" },
      { cons_addr: "bb", flag: "nil" },
    ];
    expect(await mod.absentAt("atomone-1", 1500)).toEqual(["AA"]);
    expect(await mod.absentAt("atomone-1", 999)).toBeNull();
  });
});

describe("powerEvents", () => {
  it("needs the staking_event capability", async () => {
    expect(await mod.powerEvents("atomone-1", "op")).toBeNull();
  });

  it("maps rows and nets flows only over covered windows", async () => {
    coverageFor.staking_event = { ...cov, loTime: "2020-01-01T00:00:00Z" };
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    respond = (text) => {
      if (text === mod.SQL.stakingEvents)
        return [
          {
            height: "1990",
            tx_hash: "TX",
            time: recent,
            kind: "delegate",
            validator: "op",
            validator_dst: null,
            delegator: "acc",
            amount: "50",
            denom: "uatone",
            completion_time: null,
          },
        ];
      if (text === mod.SQL.stakingFlowRows)
        return [
          { kind: "delegate", validator: "op", validator_dst: null, amount: "50", time: recent },
          { kind: "undelegate", validator: "op", validator_dst: null, amount: "80", time: recent },
        ];
      return [];
    };
    const p = await mod.powerEvents("atomone-1", "op");
    expect(p!.events[0]).toMatchObject({ height: 1990, txHash: "TX", delegator: "acc", amount: "50" });
    expect(p!.flow7).toBe("-30");
    expect(p!.flow30).toBe("-30");
    const q = queries.find((x) => x.text === mod.SQL.stakingEvents)!;
    expect(q.params).toEqual(["atomone-1", "op", 1000, 2000, 200]);
  });
});

describe("governance", () => {
  it("sums deposits per depositor and gates on coverage of the submission", async () => {
    coverageFor.gov_deposit = cov;
    respond = () => [
      { depositor: "a", coins: [{ denom: "uatone", amount: "10" }] },
      { depositor: "a", coins: [{ denom: "uatone", amount: "5" }] },
      { depositor: "b", coins: [{ denom: "uatone", amount: "1" }] },
    ];
    expect(await mod.govDeposits("atomone-1", 7, "2026-01-01T00:00:00Z")).toBeNull();
    const d = await mod.govDeposits("atomone-1", 7, "2026-07-01T00:00:00Z");
    expect(d).toEqual([
      { depositor: "a", amount: [{ denom: "uatone", amount: "15" }] },
      { depositor: "b", amount: [{ denom: "uatone", amount: "1" }] },
    ]);
  });

  it("keys a proposal's recasts by voter", async () => {
    coverageFor.vote_event = cov;
    respond = () => [
      { voter: "v1", option: "VOTE_OPTION_YES", height: "1100", time: "2026-07-01T00:00:00Z", tx_hash: "A" },
      { voter: "v1", option: "VOTE_OPTION_NO", height: "1200", time: "2026-07-02T00:00:00Z", tx_hash: "B" },
      { voter: "v2", option: "VOTE_OPTION_YES", height: "1150", time: "2026-07-01T12:00:00Z", tx_hash: "C" },
    ];
    const r = await mod.proposalRecasts("atomone-1", 9, "2026-07-01T00:00:00Z");
    expect(r?.get("v1")).toEqual(["VOTE_OPTION_YES"]);
    expect(r?.has("v2")).toBe(false);
  });

  it("reads the proposal record", async () => {
    coverageFor.gov_proposal = cov;
    respond = () => [
      {
        submit_height: "1010",
        submit_tx: "TX",
        submit_time: "2026-06-02T00:00:00Z",
        proposer: "atone1p",
        outcome: "passed",
        outcome_height: "1500",
        outcome_time: "2026-06-20T00:00:00Z",
      },
    ];
    expect(await mod.govProposalRecord("atomone-1", 3)).toEqual({
      submitHeight: 1010,
      submitTx: "TX",
      submitTime: "2026-06-02T00:00:00Z",
      proposer: "atone1p",
      outcome: "passed",
      outcomeHeight: 1500,
      outcomeTime: "2026-06-20T00:00:00Z",
    });
  });
});

describe("powerHistory", () => {
  it("returns changes oldest first with the opening power at coverage start", async () => {
    coverageFor.validator_power = cov;
    respond = (text) => {
      if (text === mod.SQL.powerHistory)
        return [
          { height: "1800", power: "20", time: "2026-09-01T00:00:00Z" },
          { height: "1500", power: "15", time: "2026-08-01T00:00:00Z" },
        ];
      if (text === mod.SQL.powerBefore) return [{ power: "10" }];
      return [];
    };
    const p = await mod.powerHistory("atomone-1", "ab");
    expect(p!.map((x) => [x.height, x.power])).toEqual([
      [1000, "10"],
      [1500, "15"],
      [1800, "20"],
    ]);
  });
});

describe("indexBehind", () => {
  it("reports a stale follower", async () => {
    expect(await mod.indexBehind("atomone-1")).toBe(true);
  });
});
