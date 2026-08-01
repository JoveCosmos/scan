import { describe, it, expect } from "vitest";
import {
  tallyShares,
  proposalStatusLabel,
  voteOptionLabel,
  isVoting,
  type Tally,
} from "@/lib/proposals";

const tally = (t: Partial<Tally>): Tally => ({
  yes: "0",
  abstain: "0",
  no: "0",
  veto: "0",
  total: "0",
  ...t,
});

describe("tallyShares", () => {
  it("returns zeros for an empty tally instead of dividing by zero", () => {
    expect(tallyShares(tally({ total: "0" }))).toEqual({
      yes: 0,
      abstain: 0,
      no: 0,
      veto: 0,
    });
  });

  it("splits a normal tally", () => {
    const s = tallyShares(
      tally({ yes: "70", no: "20", abstain: "10", veto: "0", total: "100" })
    );
    expect(s.yes).toBeCloseTo(0.7);
    expect(s.no).toBeCloseTo(0.2);
    expect(s.abstain).toBeCloseTo(0.1);
  });

  it("treats an absent veto option as zero, not NaN", () => {
    // AtomOne's gov module has no NoWithVeto at all.
    const s = tallyShares(
      tally({ yes: "60", no: "40", abstain: "0", veto: null, total: "100" })
    );
    expect(s.veto).toBe(0);
    expect(Number.isNaN(s.veto)).toBe(false);
    expect(s.yes).toBeCloseTo(0.6);
  });

  it("survives a total that is not a number", () => {
    const s = tallyShares(tally({ yes: "1", total: "not-a-number" }));
    expect(s.yes).toBe(0);
  });

  it("keeps precision on chain-scale values beyond MAX_SAFE_INTEGER", () => {
    // Real Cosmos Hub magnitudes: 58.6T yes out of ~69T.
    const s = tallyShares(
      tally({
        yes: "58635762351271",
        abstain: "2438487163076",
        no: "5868385030",
        veto: "2281672295",
        total: "61082379571672",
      })
    );
    expect(s.yes).toBeGreaterThan(0.95);
    expect(s.yes + s.abstain + s.no + s.veto).toBeCloseTo(1, 5);
  });
});

describe("labels", () => {
  it("maps proposal statuses to short labels", () => {
    expect(proposalStatusLabel("PROPOSAL_STATUS_VOTING_PERIOD")).toBe("Voting");
    expect(proposalStatusLabel("PROPOSAL_STATUS_PASSED")).toBe("Passed");
  });

  it("degrades gracefully for an unknown status", () => {
    expect(proposalStatusLabel("PROPOSAL_STATUS_SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("maps vote options", () => {
    expect(voteOptionLabel("VOTE_OPTION_NO_WITH_VETO")).toBe("No with Veto");
    expect(voteOptionLabel("VOTE_OPTION_YES")).toBe("Yes");
  });

  it("identifies the voting period", () => {
    expect(isVoting("PROPOSAL_STATUS_VOTING_PERIOD")).toBe(true);
    expect(isVoting("PROPOSAL_STATUS_PASSED")).toBe(false);
  });
});
