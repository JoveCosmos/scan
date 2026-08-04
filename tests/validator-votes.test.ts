import { describe, expect, it } from "vitest";
import { indexValidatorAccounts } from "@/lib/proposals";

// Real Cosmos Hub pair, verified against the chain: the operator address and
// the account it votes from carry the same 20-byte payload.
const GATA_OPERATOR = "cosmosvaloper10unx6s0cdqntvrumd5hs07rgd5ytcztqh8etw6";
const GATA_ACCOUNT = "cosmos10unx6s0cdqntvrumd5hs07rgd5ytcztqjnd7zf";

describe("indexValidatorAccounts", () => {
  it("keys a validator by the account it votes from", () => {
    const index = indexValidatorAccounts(
      [{ operatorAddress: GATA_OPERATOR, moniker: "GATA HUB" }],
      "cosmos"
    );

    expect(index.get(GATA_ACCOUNT)).toEqual({
      moniker: "GATA HUB",
      operatorAddress: GATA_OPERATOR,
    });
  });

  it("does not key a validator by its operator address", () => {
    // Votes are cast from the account, so an operator-address hit would mean
    // the join is matching the wrong identity.
    const index = indexValidatorAccounts(
      [{ operatorAddress: GATA_OPERATOR, moniker: "GATA HUB" }],
      "cosmos"
    );
    expect(index.get(GATA_OPERATOR)).toBeUndefined();
  });

  it("skips entries whose operator address cannot be decoded", () => {
    const index = indexValidatorAccounts(
      [
        { operatorAddress: "not-an-address", moniker: "Broken" },
        { operatorAddress: GATA_OPERATOR, moniker: "GATA HUB" },
      ],
      "cosmos"
    );
    expect(index.size).toBe(1);
  });

  it("uses the chain's own prefix rather than assuming cosmos", () => {
    const index = indexValidatorAccounts(
      [{ operatorAddress: GATA_OPERATOR, moniker: "GATA HUB" }],
      "atone"
    );
    expect([...index.keys()][0].startsWith("atone1")).toBe(true);
  });
});
