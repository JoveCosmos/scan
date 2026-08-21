import { describe, expect, it } from "vitest";
import { sortValidators, filterValidators, type ValidatorRow } from "@/lib/validator-sort";
import { emptyUptime } from "@/lib/uptime";

function row(over: Partial<ValidatorRow> & { moniker: string }): ValidatorRow {
  return {
    rank: 1,
    operatorAddress: `cosmosvaloper1${over.moniker.toLowerCase()}`,
    votingPower: 0.1,
    tokens: "1000",
    tokensLabel: "1K",
    commissionRate: 0.05,
    jailed: false,
    status: "BOND_STATUS_BONDED",
    uptime: emptyUptime(),
    delta: null,
    jailings: null,
    selfBond: null,
    ...over,
  };
}

const names = (rows: ValidatorRow[]) => rows.map((r) => r.moniker);

describe("sortValidators", () => {
  it("sorts stake with BigInt, not float precision", () => {
    // These differ only in the last digit, well beyond a double's exact range.
    const rows = [
      row({ moniker: "small", tokens: "9007199254740993000" }),
      row({ moniker: "big", tokens: "9007199254740993001" }),
    ];
    expect(names(sortValidators(rows, "tokens", "desc"))).toEqual(["big", "small"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [row({ moniker: "b" }), row({ moniker: "a" })];
    sortValidators(rows, "moniker", "asc");
    expect(names(rows)).toEqual(["b", "a"]);
  });

  it("sorts monikers case-insensitively", () => {
    const rows = [row({ moniker: "zeta" }), row({ moniker: "Alpha" })];
    expect(names(sortValidators(rows, "moniker", "asc"))).toEqual(["Alpha", "zeta"]);
  });

  it("ranks a positive 24h delta above a negative one", () => {
    const rows = [
      row({ moniker: "lost", delta: { change: BigInt(-500), ratio: -0.1 } }),
      row({ moniker: "gained", delta: { change: BigInt(900), ratio: 0.2 } }),
    ];
    expect(names(sortValidators(rows, "delta", "desc"))).toEqual(["gained", "lost"]);
  });

  it("sinks unknown deltas below real ones in both directions", () => {
    const rows = [
      row({ moniker: "unknown", delta: null }),
      row({ moniker: "down", delta: { change: BigInt(-10), ratio: -0.01 } }),
    ];
    // A missing reading must never outrank a real loss, nor pose as the best.
    expect(names(sortValidators(rows, "delta", "desc"))).toEqual(["down", "unknown"]);
    expect(names(sortValidators(rows, "delta", "asc"))).toEqual(["unknown", "down"]);
  });

  it("sinks unknown uptime below measured uptime", () => {
    const rows = [
      row({ moniker: "unmeasured", uptime: emptyUptime() }),
      row({ moniker: "poor", uptime: { ...emptyUptime(), ratio: 0.5 } }),
    ];
    expect(names(sortValidators(rows, "uptime", "desc"))).toEqual([
      "poor",
      "unmeasured",
    ]);
  });

  it("puts the most recently jailed first, never-jailed last", () => {
    const rows = [
      row({ moniker: "never", uptime: emptyUptime() }),
      row({
        moniker: "old",
        uptime: { ...emptyUptime(), jailedUntil: "2023-01-01T00:00:00Z" },
      }),
      row({
        moniker: "recent",
        uptime: { ...emptyUptime(), jailedUntil: "2026-07-01T00:00:00Z" },
      }),
    ];
    expect(names(sortValidators(rows, "jailed", "desc"))).toEqual([
      "recent",
      "old",
      "never",
    ]);
  });

  it("sorts jailing counts, with unknown below never-jailed", () => {
    // "We have no history for this validator" must not outrank "this validator
    // has a clean record" — that would read as the opposite of what it means.
    const rows = [
      row({ moniker: "unknown", jailings: null }),
      row({ moniker: "clean", jailings: { count: 0, tombstoned: false } }),
      row({ moniker: "twice", jailings: { count: 2, tombstoned: false } }),
    ];
    expect(names(sortValidators(rows, "jailings", "desc"))).toEqual([
      "twice",
      "clean",
      "unknown",
    ]);
  });

  it("reverses cleanly for every key", () => {
    const rows = [
      row({ moniker: "a", rank: 1, commissionRate: 0.01 }),
      row({ moniker: "b", rank: 2, commissionRate: 0.2 }),
    ];
    expect(names(sortValidators(rows, "commission", "asc"))).toEqual(["a", "b"]);
    expect(names(sortValidators(rows, "commission", "desc"))).toEqual(["b", "a"]);
    expect(names(sortValidators(rows, "rank", "desc"))).toEqual(["b", "a"]);
  });
});

describe("filterValidators", () => {
  const rows = [
    row({ moniker: "Ubik Capital", operatorAddress: "atonevaloper1abc" }),
    row({ moniker: "DKCMC", operatorAddress: "atonevaloper1xyz" }),
    row({ moniker: "nylira.net", operatorAddress: "atonevaloper1qqq" }),
  ];

  it("returns everything for an empty or whitespace query", () => {
    expect(filterValidators(rows, "")).toHaveLength(3);
    expect(filterValidators(rows, "   ")).toHaveLength(3);
  });

  it("matches part of a moniker, ignoring case", () => {
    expect(filterValidators(rows, "ubik").map((v) => v.moniker)).toEqual(["Ubik Capital"]);
    expect(filterValidators(rows, "CAPITAL").map((v) => v.moniker)).toEqual(["Ubik Capital"]);
  });

  it("matches an operator address, so a pasted address finds its validator", () => {
    expect(filterValidators(rows, "atonevaloper1xyz").map((v) => v.moniker)).toEqual(["DKCMC"]);
  });

  it("trims the query, since pasted addresses carry whitespace", () => {
    expect(filterValidators(rows, "  nylira  ").map((v) => v.moniker)).toEqual(["nylira.net"]);
  });

  it("returns nothing when there is no match", () => {
    expect(filterValidators(rows, "nonexistent")).toEqual([]);
  });

  // The rank column is the chain's ranking, so filtering must not renumber.
  it("preserves the ranks of the rows it keeps", () => {
    const ranked = [row({ moniker: "A", rank: 1 }), row({ moniker: "B", rank: 7 })];
    expect(filterValidators(ranked, "B")[0].rank).toBe(7);
  });
});

describe("sortValidators by self bond", () => {
  const rows = [
    row({ moniker: "none", selfBond: null }),
    row({ moniker: "tiny", selfBond: { amount: "1000000", share: 0.0000001 } }),
    row({ moniker: "heavy", selfBond: { amount: "3429157000000", share: 0.8507 } }),
    row({ moniker: "mid", selfBond: { amount: "50000000000", share: 0.0139 } }),
  ];

  // Share, not amount: a large validator bonding 1 token is the case the column
  // exists to expose, and its raw self bond can still outsize a small one's.
  it("ranks by share of stake, biggest first", () => {
    expect(sortValidators(rows, "selfBond", "desc").map((v) => v.moniker)).toEqual([
      "heavy",
      "mid",
      "tiny",
      "none",
    ]);
  });

  it("sorts an unanswered self bond below a real zero", () => {
    const pair = [
      row({ moniker: "unknown", selfBond: null }),
      row({ moniker: "zero", selfBond: { amount: "0", share: 0 } }),
    ];
    expect(sortValidators(pair, "selfBond", "asc").map((v) => v.moniker)).toEqual([
      "unknown",
      "zero",
    ]);
  });
});
