import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodeMessage, labelForType, parseCoinString, type DecodedField } from "@/lib/msg-decode";
import { rawTxToSummary, eventsOf, type RawTxResponse } from "@/lib/txs";
import { transferForAddress, partiesOf } from "@/lib/tx-parties";
import { exactAmount, shortAmount, formatCoinShort, denomInfoFromTrace } from "@/lib/coin";

function fixture(prefix: string): RawTxResponse {
  const dir = path.join(__dirname, "fixtures", "txs");
  const file = fs.readdirSync(dir).find((f) => f.startsWith(`hub-${prefix}`));
  if (!file) throw new Error(`no fixture ${prefix}`);
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).tx_response;
}

const field = (fields: DecodedField[], label: string) => fields.find((f) => f.label === label)?.value;

describe("staking roles", () => {
  it("names the delegator and validator by role on an undelegation", () => {
    const tx = rawTxToSummary(fixture("8868"), "cosmoshub-4", true);
    const m = tx.messages[0];
    const delegator = field(m.fields!, "Delegator");
    const validator = field(m.fields!, "Validator");
    expect(delegator).toMatchObject({ kind: "address" });
    expect((delegator as { address: string }).address).toMatch(/^cosmos1/);
    expect((validator as { address: string }).address).toMatch(/^cosmosvaloper1/);
  });

  it("shows the redelegating delegator and both validators", () => {
    const tx = rawTxToSummary(fixture("8FB0"), "cosmoshub-4", true);
    const f = tx.messages[0].fields!;
    expect((field(f, "Delegator") as { address: string }).address).toMatch(/^cosmos1/);
    expect((field(f, "From validator") as { address: string }).address).toMatch(/valoper/);
    expect((field(f, "To validator") as { address: string }).address).toMatch(/valoper/);
    expect(partiesOf({ "@type": "/cosmos.staking.v1beta1.MsgBeginRedelegate", delegator_address: "d", validator_src_address: "s", validator_dst_address: "t" }).map((p) => p.role)).toEqual([
      "delegator",
      "srcValidator",
      "dstValidator",
    ]);
  });
});

describe("amounts from events", () => {
  it("fills each reward claim's amount from its own withdraw_rewards event", () => {
    const tx = rawTxToSummary(fixture("0E99"), "cosmoshub-4", true);
    expect(tx.messages[0].transfer?.amount).toEqual([{ denom: "uatom", amount: "498364" }]);
    expect(tx.messages[1].transfer?.amount).toEqual([{ denom: "uatom", amount: "63060" }]);
    expect(tx.primaryLabel).toBe("Claim Rewards +1");
  });

  it("tags events with their message index", () => {
    const events = eventsOf(fixture("0E99"));
    expect(events.filter((e) => e.type === "withdraw_rewards").map((e) => e.msgIndex)).toEqual([0, 1]);
    expect(events.find((e) => e.type === "tx")?.msgIndex).toBeNull();
  });
});

describe("authz", () => {
  it("keeps MsgExec as one message with the grantee and its inner messages beneath", () => {
    const tx = rawTxToSummary(fixture("62C0"), "cosmoshub-4", true);
    expect(tx.messageCount).toBe(1);
    expect(tx.messages[0].label).toBe("Authz Exec");
    expect(field(tx.messages[0].fields!, "Grantee")).toMatchObject({ kind: "address" });
    expect(tx.messages[0].inner?.[0].label).toBe("Delegate");
    expect(tx.primaryLabel).toBe("Delegate");
  });
});

describe("IBC", () => {
  it("names the receive, not the client update, and decodes the packet", () => {
    const tx = rawTxToSummary(fixture("32DC"), "cosmoshub-4", true);
    expect(tx.primaryLabel).toBe("IBC Receive +1");
    const f = tx.messages[1].fields!;
    expect(field(f, "Sequence")).toMatchObject({ kind: "text" });
    expect(field(f, "Relayer")).toMatchObject({ kind: "address" });
  });

  it("gives a transfer its channel and sequence", () => {
    const tx = rawTxToSummary(fixture("660D"), "cosmoshub-4", true);
    const f = tx.messages[0].fields!;
    expect((field(f, "Source channel") as { text: string }).text).toMatch(/^transfer\/channel-\d+$/);
    expect(field(f, "Sequence")).toBeDefined();
  });
});

describe("contracts and unknown types", () => {
  it("shows the contract as an address and the message as JSON", () => {
    const tx = rawTxToSummary(fixture("40E9"), "cosmoshub-4", true);
    const f = tx.messages[0].fields!;
    expect(field(f, "Contract")).toMatchObject({ kind: "address" });
    expect(field(f, "Message")).toMatchObject({ kind: "json" });
  });

  it("falls back to the type URL and JSON for a type it doesn't know", () => {
    const d = decodeMessage("x", "/foo.bar.v1.MsgFrobnicate", { thing: 1 });
    expect(d.label).toBe("Frobnicate");
    expect(d.rows[0]).toMatchObject({ label: "Type", value: "/foo.bar.v1.MsgFrobnicate" });
  });

  it("links a vote's proposal", () => {
    const d = decodeMessage("cosmoshub-4", "/cosmos.gov.v1.MsgVote", { proposal_id: "1057", voter: "cosmos1x", option: "VOTE_OPTION_YES" });
    expect(d.rows.find((r) => r.label === "Proposal")).toMatchObject({ href: "/cosmoshub-4/proposals/1057", value: "#1057" });
    expect(d.rows.find((r) => r.label === "Option")?.value).toBe("Yes");
    expect(labelForType("/cosmos.gov.v1.MsgVote")).toBe("Vote");
  });
});

describe("transferForAddress", () => {
  it("reports a multi-send recipient's own amount, not the sender's total", () => {
    const messages = [
      {
        transfer: { from: "a", to: null, amount: [{ denom: "u", amount: "300" }], staking: false },
        io: {
          inputs: [{ address: "a", coins: [{ denom: "u", amount: "300" }] }],
          outputs: [
            { address: "b", coins: [{ denom: "u", amount: "1" }] },
            { address: "c", coins: [{ denom: "u", amount: "299" }] },
          ],
        },
      },
    ];
    expect(transferForAddress(messages, "b")).toEqual({ direction: "in", counterparty: "a", amount: [{ denom: "u", amount: "1" }] });
    expect(transferForAddress(messages, "a")?.direction).toBe("out");
    expect(transferForAddress(messages, "z")).toBeNull();
  });

  it("picks this account's message in a batch, not the first one", () => {
    const messages = [
      { transfer: { from: "x", to: "v", amount: [{ denom: "u", amount: "5" }], staking: true } },
      { transfer: { from: "me", to: "v", amount: [{ denom: "u", amount: "9" }], staking: true } },
    ];
    expect(transferForAddress(messages, "me")?.amount).toEqual([{ denom: "u", amount: "9" }]);
  });
});

describe("coin formatting", () => {
  it("is exact with BigInt and never abbreviates", () => {
    expect(exactAmount("1000000000", 6)).toBe("1,000");
    expect(exactAmount("5", 6)).toBe("0.000005");
    expect(exactAmount("999999997125000000", 6)).toBe("999,999,997,125");
  });

  it("marks dust instead of rounding it to zero", () => {
    expect(shortAmount("5", 6, 4)).toBe("<0.0001");
    expect(shortAmount("57800000", 6)).toBe("57.8");
    expect(formatCoinShort({ denom: "uatom", amount: "1000000000" }, [{ denom: "uatom", symbol: "ATOM", exponent: 6 }])).toBe("1,000 ATOM");
  });

  it("scales an IBC denom by its home chain's exponent", () => {
    const carried = [{ denom: "uosmo", symbol: "OSMO", exponent: 6 }];
    expect(denomInfoFromTrace("ibc/AB", { base: "uosmo", symbol: "OSMO" }, carried)).toEqual({ denom: "ibc/AB", symbol: "OSMO", exponent: 6 });
    expect(denomInfoFromTrace("ibc/CD", { base: "inj", symbol: "INJ" }, carried)?.exponent).toBe(18);
    expect(parseCoinString("498364uatom,12ibc/ABC")).toEqual([
      { amount: "498364", denom: "uatom" },
      { amount: "12", denom: "ibc/ABC" },
    ]);
  });
});

describe("authz grants", () => {
  const grant = (authorization: Record<string, unknown>) => ({
    granter: "atone1granter",
    grantee: "atone1grantee",
    grant: { authorization, expiration: "2027-01-01T00:00:00Z" },
  });
  const field = (fields: DecodedField[], label: string) =>
    fields.find((f) => f.label === label || f.label.endsWith(` ${label.toLowerCase()}`))?.value;

  it("names the kind of a Stake Authorization, so delegate and redelegate grants differ", () => {
    // The operator's example: a Restake grant, delegate only, no cap.
    const d = decodeMessage("atomone-testnet-1", "/cosmos.authz.v1beta1.MsgGrant", grant({
      "@type": "/cosmos.staking.v1beta1.StakeAuthorization",
      max_tokens: null,
      authorization_type: "AUTHORIZATION_TYPE_DELEGATE",
    }));
    expect(field(d.fields, "Authorization")).toEqual({ kind: "text", text: "Stake Authorization, Delegate", mono: false });
    expect(field(d.fields, "Max tokens")).toBeUndefined();

    const r = decodeMessage("atomone-1", "/cosmos.authz.v1beta1.MsgGrant", grant({
      "@type": "/cosmos.staking.v1beta1.StakeAuthorization",
      authorization_type: "AUTHORIZATION_TYPE_REDELEGATE",
    }));
    expect(field(r.fields, "Authorization")).toMatchObject({ text: "Stake Authorization, Redelegate" });
  });

  it("shows the cap and every allowed validator", () => {
    const d = decodeMessage("atomone-1", "/cosmos.authz.v1beta1.MsgGrant", grant({
      "@type": "/cosmos.staking.v1beta1.StakeAuthorization",
      authorization_type: "AUTHORIZATION_TYPE_DELEGATE",
      max_tokens: { denom: "uatone", amount: "5000000" },
      allow_list: { address: ["atonevaloper1a", "atonevaloper1b", "atonevaloper1c"] },
    }));
    expect(field(d.fields, "Max tokens")).toEqual({ kind: "coins", coins: [{ denom: "uatone", amount: "5000000" }] });
    const allowed = d.fields.filter((f) => f.value.kind === "address" && f.value.address.startsWith("atonevaloper"));
    expect(allowed.map((f) => f.label)).toEqual(["3 allowed validators", "", ""]);
  });

  it("keeps a Generic Authorization's message", () => {
    const d = decodeMessage("atomone-1", "/cosmos.authz.v1beta1.MsgGrant", grant({
      "@type": "/cosmos.authz.v1beta1.GenericAuthorization",
      msg: "/cosmos.gov.v1beta1.MsgVote",
    }));
    expect(field(d.fields, "Message")).toMatchObject({ text: "/cosmos.gov.v1beta1.MsgVote" });
    expect(field(d.fields, "Authorization")).toMatchObject({ text: "Generic Authorization" });
  });
});
