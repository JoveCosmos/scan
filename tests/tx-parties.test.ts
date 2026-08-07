import { describe, expect, it } from "vitest";
import {
  transferOf,
  primaryTransfer,
  directionFor,
  flattenMessages,
  type RawMessage,
} from "@/lib/tx-parties";

// Shapes taken verbatim from live Cosmos Hub transactions.
const SEND: RawMessage = {
  "@type": "/cosmos.bank.v1beta1.MsgSend",
  from_address: "cosmos1gctcu6akw5jtq4zl3lyp0rt8qf4fuppk6tak4n",
  to_address: "cosmos1x7cmwyvzl75rgpgqd2upju2d86c0rvg7yngxss",
  amount: [{ denom: "uatom", amount: "57999990" }],
};

const DELEGATE: RawMessage = {
  "@type": "/cosmos.staking.v1beta1.MsgDelegate",
  delegator_address: "cosmos1azzaflcuexu06gc7nxf4cre8txut0cf4djh7y7",
  validator_address: "cosmosvaloper1tflk30mq5vgqjdly92kkhhq3raev2hnz6eete3",
  amount: { denom: "uatom", amount: "904114" },
};

describe("transferOf", () => {
  it("reads both parties and the amount from a send", () => {
    expect(transferOf(SEND)).toEqual({
      from: SEND.from_address,
      to: SEND.to_address,
      amount: [{ denom: "uatom", amount: "57999990" }],
      staking: false,
    });
  });

  it("handles a single-coin amount as well as a list", () => {
    // MsgDelegate carries one coin, MsgSend carries an array.
    const t = transferOf(DELEGATE);
    expect(t?.amount).toEqual([{ denom: "uatom", amount: "904114" }]);
    expect(t?.staking).toBe(true);
  });

  it("points an undelegation back out of the validator", () => {
    const t = transferOf({ ...DELEGATE, "@type": "/cosmos.staking.v1beta1.MsgUndelegate" });
    expect(t?.from).toBe(DELEGATE.validator_address);
    expect(t?.to).toBe(DELEGATE.delegator_address);
  });

  it("names the parties of a reward withdrawal but claims no amount", () => {
    // The figure lives only in the events, so it must not be invented.
    const t = transferOf({
      "@type": "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
      delegator_address: "cosmos1abc",
      validator_address: "cosmosvaloper1xyz",
    });
    expect(t?.amount).toEqual([]);
    expect(t?.to).toBe("cosmos1abc");
  });

  it("returns null for a type with no transfer meaning", () => {
    expect(transferOf({ "@type": "/cosmos.gov.v1.MsgVote", voter: "cosmos1abc" })).toBeNull();
  });
});

describe("flattenMessages", () => {
  it("unwraps a send executed through authz", () => {
    const exec: RawMessage = {
      "@type": "/cosmos.authz.v1beta1.MsgExec",
      grantee: "cosmos1grantee",
      msgs: [SEND],
    };
    const flat = flattenMessages([exec]);
    expect(flat).toHaveLength(1);
    expect(transferOf(flat[0])?.from).toBe(SEND.from_address);
  });

  it("stops at the depth cap instead of recursing forever", () => {
    let nested: RawMessage = SEND;
    for (let i = 0; i < 12; i++) {
      nested = { "@type": "/cosmos.authz.v1beta1.MsgExec", msgs: [nested] };
    }
    expect(flattenMessages([nested])).toEqual([]);
  });
});

describe("primaryTransfer", () => {
  it("prefers the message that actually moved value", () => {
    const vote: RawMessage = { "@type": "/cosmos.gov.v1.MsgVote", voter: "cosmos1abc" };
    expect(primaryTransfer([vote, SEND])?.amount[0].amount).toBe("57999990");
  });

  it("falls back to a message that only names parties", () => {
    const claim: RawMessage = {
      "@type": "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
      delegator_address: "cosmos1abc",
      validator_address: "cosmosvaloper1xyz",
    };
    expect(primaryTransfer([claim])?.to).toBe("cosmos1abc");
  });

  it("returns null when nothing in the transaction is a transfer", () => {
    expect(primaryTransfer([{ "@type": "/cosmos.gov.v1.MsgVote" }])).toBeNull();
  });
});

describe("directionFor", () => {
  const t = transferOf(SEND)!;

  it("reads out for the sender and in for the recipient", () => {
    expect(directionFor(t, SEND.from_address!)).toBe("out");
    expect(directionFor(t, SEND.to_address!)).toBe("in");
  });

  it("reads self when an address sends to itself", () => {
    expect(directionFor({ ...t, to: t.from }, t.from!)).toBe("self");
  });

  it("returns null for an address that is not a party", () => {
    // A page must not claim a direction for a transaction the account only
    // appears in incidentally.
    expect(directionFor(t, "cosmos1uninvolved")).toBeNull();
  });
});
