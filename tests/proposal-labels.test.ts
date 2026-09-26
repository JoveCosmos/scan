import { describe, expect, it } from "vitest";
import { proposalTypeLabel } from "@/lib/proposals";

describe("proposalTypeLabel", () => {
  it("names plain messages", () => {
    expect(proposalTypeLabel("/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade")).toBe("Software Upgrade");
    expect(proposalTypeLabel("/cosmos.distribution.v1beta1.MsgCommunityPoolSpend")).toBe(
      "Community Pool Spend"
    );
  });
  it("names the module on params updates", () => {
    expect(proposalTypeLabel("/cosmos.staking.v1beta1.MsgUpdateParams")).toBe("Update Params · staking");
  });
  it("reads legacy content types", () => {
    expect(
      proposalTypeLabel(
        "/cosmos.gov.v1.MsgExecLegacyContent",
        "/cosmos.params.v1beta1.ParameterChangeProposal"
      )
    ).toBe("Parameter Change");
    expect(proposalTypeLabel("/cosmos.gov.v1.MsgExecLegacyContent", "/cosmos.gov.v1beta1.TextProposal")).toBe("Text");
  });
});
