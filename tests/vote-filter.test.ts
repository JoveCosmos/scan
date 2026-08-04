import { describe, expect, it } from "vitest";
import { filterVotes, type VoteRow } from "@/components/votes-table";

const row = (
  voter: string,
  moniker?: string,
  operatorAddress = "cosmosvaloper1abc"
): VoteRow => ({
  voter,
  options: [{ option: "VOTE_OPTION_YES", weight: 1 }],
  primary: "VOTE_OPTION_YES",
  weighted: false,
  validator: moniker ? { moniker, operatorAddress } : null,
});

const VOTES: VoteRow[] = [
  row("cosmos1gata0000000000000000000000000000aaaa", "GATA HUB"),
  row("cosmos1coin1111111111111111111111111111bbbb", "Coinage x DAIC"),
  row("cosmos1plain222222222222222222222222222cccc"),
];

describe("filterVotes", () => {
  it("returns everything for an empty or whitespace query", () => {
    expect(filterVotes(VOTES, "")).toHaveLength(3);
    expect(filterVotes(VOTES, "   ")).toHaveLength(3);
  });

  it("matches a validator by moniker, case-insensitively", () => {
    expect(filterVotes(VOTES, "gata")).toHaveLength(1);
    expect(filterVotes(VOTES, "GATA")[0].validator?.moniker).toBe("GATA HUB");
  });

  it("matches a moniker on a partial word", () => {
    expect(filterVotes(VOTES, "daic")).toHaveLength(1);
  });

  it("matches a plain voter by full pasted address", () => {
    const target = VOTES[2].voter;
    expect(filterVotes(VOTES, target)).toHaveLength(1);
    // Pasted addresses often carry stray whitespace.
    expect(filterVotes(VOTES, `  ${target}  `)).toHaveLength(1);
  });

  it("matches an address fragment", () => {
    expect(filterVotes(VOTES, "1plain")).toHaveLength(1);
  });

  it("returns nothing when there is no match", () => {
    expect(filterVotes(VOTES, "no-such-voter")).toHaveLength(0);
  });

  it("does not crash on a voter with no validator identity", () => {
    // The moniker side of the comparison is absent for most voters; the guard
    // there is what keeps this from throwing.
    expect(() => filterVotes(VOTES, "hub")).not.toThrow();
    expect(filterVotes(VOTES, "hub")).toHaveLength(1);
  });
});
