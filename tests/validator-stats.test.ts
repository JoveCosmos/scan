import { describe, expect, it } from "vitest";
import {
  eventKind,
  expectedProposals,
  proposedBlocks,
  proposerFairness,
  relayerPackets,
  validatorEvents,
  validatorVotes,
} from "@/lib/indexer-validator";
import { jailedNow, longestMissStreak, missBudget, emptyUptime } from "@/lib/uptime";

describe("expectedProposals", () => {
  it("weights each interval by the share held at its start", () => {
    // 10% for 100 blocks, then 20% for 100 blocks → 10 + 20 = 30 expected.
    const r = expectedProposals([
      { height: 1000, total: 1000, mine: 100 },
      { height: 1100, total: 1000, mine: 200 },
      { height: 1200, total: 1000, mine: 200 },
    ]);
    expect(r).toEqual({ from: 1000, to: 1200, expected: 30 });
  });

  it("measures a validator that joined late only over its own time", () => {
    const r = expectedProposals([
      { height: 0, total: 1000, mine: 0 },
      { height: 500, total: 1000, mine: 100 },
      { height: 1000, total: 1000, mine: 100 },
    ]);
    // Present for 500 of 1000 blocks at 10%: owed 50, not 100.
    expect(r).toEqual({ from: 500, to: 1000, expected: 50 });
  });

  it("returns null with no interval where the validator held stake", () => {
    expect(expectedProposals([{ height: 1, total: 10, mine: 5 }])).toBeNull();
    expect(
      expectedProposals([
        { height: 1, total: 10, mine: 0 },
        { height: 2, total: 10, mine: 0 },
      ])
    ).toBeNull();
  });

  it("does not depend on input order", () => {
    const a = expectedProposals([
      { height: 20, total: 100, mine: 10 },
      { height: 10, total: 100, mine: 10 },
    ]);
    expect(a).toEqual({ from: 10, to: 20, expected: 1 });
  });
});

describe("missBudget", () => {
  it("is window × (1 − min_signed) − missed", () => {
    expect(missBudget(10_000, 0.05, 20)).toBe(9_480);
    expect(missBudget(10_000, 0.95, 20)).toBe(480);
  });
  it("floors at zero and needs every input", () => {
    expect(missBudget(100, 0.9, 50)).toBe(0);
    expect(missBudget(null, 0.5, 1)).toBeNull();
    expect(missBudget(100, null, 1)).toBeNull();
    expect(missBudget(100, 0.5, null)).toBeNull();
  });
});

describe("longestMissStreak", () => {
  it("counts the longest consecutive run of misses", () => {
    expect(longestMissStreak([true, false, false, true, false, false, false, true])).toBe(3);
    expect(longestMissStreak([true, true])).toBe(0);
    expect(longestMissStreak([])).toBe(0);
  });
});

describe("jailedNow", () => {
  it("trusts the jailed flag, then a future jailed_until", () => {
    const u = emptyUptime();
    expect(jailedNow(u, true)).toBe(true);
    expect(jailedNow({ ...u, jailedUntil: "2999-01-01T00:00:00Z" }, false)).toBe(true);
    expect(jailedNow({ ...u, jailedUntil: "2020-01-01T00:00:00Z" }, false)).toBe(false);
    expect(jailedNow(u, false)).toBe(false);
  });
});

describe("eventKind", () => {
  it("classifies validator transactions by message type", () => {
    expect(eventKind(["/cosmos.slashing.v1beta1.MsgUnjail"])).toBe("unjail");
    expect(eventKind(["/cosmos.staking.v1beta1.MsgEditValidator"])).toBe("edit");
    expect(eventKind(["/cosmos.staking.v1beta1.MsgCreateValidator"])).toBe("create");
    expect(
      eventKind([
        "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
        "/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission",
      ])
    ).toBe("commission");
    expect(eventKind(["/cosmos.bank.v1beta1.MsgSend"])).toBeNull();
  });
});

describe("indexed reads without an index", () => {
  // No INDEXER_DATABASE_URL in tests: every read must answer null, never a zero.
  it("answer null", async () => {
    expect(await proposedBlocks("atomone-1", "ABC")).toBeNull();
    expect(await proposerFairness("atomone-1", "atonevaloper1x", "ABC")).toBeNull();
    expect(await validatorEvents("atomone-1", "atone1x")).toBeNull();
    expect(await validatorVotes("atomone-1", "atone1x", null)).toBeNull();
    expect(await relayerPackets("atomone-1", ["/ibc.core.channel.v1.MsgRecvPacket"])).toBeNull();
  });
});
