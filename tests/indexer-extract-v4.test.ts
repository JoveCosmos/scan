import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractBlock,
  EXTRACT_VERSION,
  ROLE,
  type BlockResponse,
  type BlockResultsResponse,
  type ExtractedBlock,
  type TransferRow,
} from "../indexer/src/extract";
import { placeEvents } from "../indexer/src/events";

/**
 * Extract version 4 against real AtomOne blocks from both event eras.
 *
 * Before the upgrade at ~9,550,000 a transaction's events carry no msg_index;
 * after it they do. Every fixture below was captured from the archive node and
 * trimmed only of block-level events that no extractor reads. The expected
 * values were checked against the chain's own view of each transaction
 * (LCD /cosmos/tx/v1beta1/txs/{hash}).
 */
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

function at(height: number): ExtractedBlock {
  const out = extractBlock(
    fixture(`atomone-block-${height}.json`) as BlockResponse,
    fixture(`atomone-block-results-${height}.json`) as BlockResultsResponse
  );
  if (!out) throw new Error(`fixture ${height} did not extract`);
  return out;
}

function txResult(height: number, i = 0) {
  const r = fixture(`atomone-block-results-${height}.json`);
  return (r.result ?? r).txs_results[i];
}

/** The key transfer had up to version 3, as a v3 row would have seen it. */
function v3Key(t: TransferRow, preUpgrade: boolean): string {
  // Pre-upgrade events have no msg_index, so version 3 filed every one of them
  // under -1 - and a transfer at -1 is, by its rule, the fee.
  const msgIndex = preUpgrade ? -1 : t.msgIndex;
  const kind = preUpgrade && t.kind === "transfer" ? "fee" : t.kind;
  return `${t.txHash}|${msgIndex}|${t.coinIndex}|${kind}`;
}

const v4Key = (t: TransferRow) => `${t.txHash}|${t.eventSeq}|${t.coinIndex}`;

const MODULE_FEE_COLLECTOR = "atone17xpfvakm2amg962yls6f84z3kell8c5l7el8a9";

describe("version", () => {
  // 5 since 2026-10-13 (tx_msg.raw); everything version 4 wrote, 5 still writes.
  it("is 5", () => {
    expect(EXTRACT_VERSION).toBe(5);
    expect(at(9515610).extractVersion).toBe(5);
  });
});

describe("finding 1: a pre-upgrade MsgSend (9515610)", () => {
  const out = at(9515610);

  it("recovers message grouping from the tx log", () => {
    expect(placeEvents(txResult(9515610)).grouping).toBe("log");
  });

  it("stores the send as a transfer, not a fee", () => {
    const sends = out.transfers.filter((t) => t.kind === "transfer");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      msgIndex: 0,
      fromAddr: "atone1pz0gys67zv6dl0g69dree3yees48plzun5xcek",
      toAddr: "atone1tkvkxz9fqrcd45zp3pxhtz7fhzmxgm5vp4cx33",
      amount: "2958349",
      denom: "uatone",
    });
  });

  it("keeps the fee as its own row", () => {
    const fees = out.transfers.filter((t) => t.kind === "fee");
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ msgIndex: -1, toAddr: MODULE_FEE_COLLECTOR, amount: "17358" });
  });

  it("collided under the version-3 key, so one row overwrote the other", () => {
    const old = new Set(out.transfers.map((t) => v3Key(t, true)));
    expect(out.transfers).toHaveLength(2);
    expect(old.size).toBe(1);
    expect(new Set(out.transfers.map(v4Key)).size).toBe(2);
  });
});

describe("finding 1: a pre-upgrade MsgMultiSend (2415255)", () => {
  const out = at(2415255);

  it("gives every output its own row with the input as sender", () => {
    // MultiSend's transfer events name no sender; the input's coin_spent does.
    const sends = out.transfers.filter((t) => t.kind === "transfer");
    expect(sends.map((t) => t.toAddr)).toEqual([
      "atone1ap3e85e9tx4umy9w4s559yegzs7y4wcjd9lxek",
      "atone12vfpmlvmqrh9p0kcrtv6lw9ylkh7reucc3spla",
    ]);
    for (const t of sends) expect(t.fromAddr).toBe("atone1zgvarczx9n8h5wdcuax370zyvdegkvw62hrgtw");
  });

  it("reads the sender of a message with no top-level address field", () => {
    expect(out.txMsgs[0].sender).toBe("atone1zgvarczx9n8h5wdcuax370zyvdegkvw62hrgtw");
  });

  it("keeps the memo", () => {
    expect(out.txs[0].memo).toMatch(/^✅ Account is listed in Astrovault AIRDROP/);
  });
});

describe("findings 1 and 2: authz MsgExec batches in both eras", () => {
  for (const [height, preUpgrade, inner] of [
    [9294803, true, 26],
    [10525094, false, 6],
  ] as const) {
    describe(`${preUpgrade ? "pre" : "post"}-upgrade (${height})`, () => {
      const out = at(height);

      it("records every inner message under the MsgExec", () => {
        const rows = out.txMsgs.filter((m) => m.innerIndex >= 0);
        expect(rows).toHaveLength(inner);
        expect(rows.every((m) => m.msgIndex === 0)).toBe(true);
        expect(rows.map((m) => m.innerIndex)).toEqual([...Array(inner).keys()]);
        expect(out.txMsgs.find((m) => m.innerIndex === -1)!.typeUrl).toBe("/cosmos.authz.v1beta1.MsgExec");
      });

      it("keeps each inner message's transfers apart", () => {
        const idx = new Set(out.transfers.filter((t) => t.kind !== "fee").map((t) => t.authzMsgIndex));
        expect(idx.size).toBe(inner);
        expect(new Set(out.transfers.map(v4Key)).size).toBe(out.transfers.length);
      });

      it("collapsed to a handful of rows under the version-3 key", () => {
        const old = new Set(out.transfers.map((t) => v3Key(t, preUpgrade)));
        expect(old.size).toBeLessThan(out.transfers.length / 4);
      });

      it("records a staking event per inner delegation", () => {
        expect(out.stakingEvents.filter((s) => s.kind === "delegate")).toHaveLength(inner);
        for (const s of out.stakingEvents) expect(s.authzMsgIndex).not.toBeNull();
      });

      it("names grantee and granters as parties with their roles", () => {
        const grantee = out.txMsgs[0].sender!;
        const g = out.txParties.find((p) => p.address === grantee)!;
        expect(g.roles & ROLE.grantee).toBeTruthy();
        expect(g.roles & ROLE.signer).toBeTruthy();
        const granters = out.txParties.filter((p) => p.roles & ROLE.granter);
        expect(granters.length).toBeGreaterThan(0);
        for (const p of granters) expect(p.roles & ROLE.delegator).toBeTruthy();
      });
    });
  }

  it("keeps 105 rows pre-upgrade and 23 post-upgrade where version 3 kept a few", () => {
    const pre = at(9294803).transfers;
    const post = at(10525094).transfers;
    expect(pre).toHaveLength(105);
    expect(post).toHaveLength(23);
    expect(new Set(pre.map((t) => v3Key(t, true))).size).toBeLessThanOrEqual(4);
    expect(new Set(post.map((t) => v3Key(t, false))).size).toBe(5);
  });
});

describe("module accounts are not parties", () => {
  it("leaves the fee collector out of every party list", () => {
    for (const h of [9515610, 9294803, 10525094, 10524728, 10524863]) {
      const addrs = at(h).txParties.map((p) => p.address);
      expect(addrs).not.toContain(MODULE_FEE_COLLECTOR);
    }
  });

  it("leaves the IBC escrow out", () => {
    // sha256("ics20-1\0transfer/channel-2")[:20], the escrow MsgTransfer pays into.
    const out = at(10524728);
    const escrow = out.transfers.find((t) => t.kind === "transfer")!.toAddr!;
    expect(out.txParties.map((p) => p.address)).not.toContain(escrow);
  });
});

describe("failed transactions (10519879 post, 9372820 pre)", () => {
  it("take message types from the bytes, since no message event fired", () => {
    expect(at(10519879).txs[0]).toMatchObject({ code: 11, msgTypes: ["/cosmos.staking.v1beta1.MsgDelegate"] });
    expect(at(9372820).txs[0]).toMatchObject({ code: 11, msgTypes: ["/atomone.gov.v1.MsgVote"] });
  });

  it("keep only the fee, which was still charged", () => {
    for (const h of [10519879, 9372820]) {
      const out = at(h);
      expect(out.transfers.map((t) => t.kind)).toEqual(["fee"]);
      expect(out.stakingEvents).toEqual([]);
      expect(out.votes).toEqual([]);
    }
  });

  it("still name the signer", () => {
    expect(at(10519879).txParties).toEqual([
      expect.objectContaining({ address: "atone108gvrsya3g5pknyz9deqm0xstrf9n4s2uu5clu" }),
    ]);
  });
});

describe("tx metadata", () => {
  it("reads signers, every fee coin and the memo", () => {
    const t = at(10524171).txs[0];
    expect(t.signers).toEqual(["atone16vmp7sz28pnvgz6f3zm6q93y39jsd33a6ve2wc"]);
    expect(t.feeCoins).toEqual([{ amount: "97412", denom: "uphoton" }]);
    expect(t.memo).toMatch(/^Inter Blockchain Services Relayer/);
    expect(t.feeGranter).toBeNull();
  });
});

describe("IBC packets", () => {
  it("records a send with its route and timeout (10524728)", () => {
    const [p] = at(10524728).ibcPackets;
    expect(p).toMatchObject({
      direction: "out",
      srcPort: "transfer",
      srcChannel: "channel-2",
      sequence: "114477",
      dstChannel: "channel-94814",
      sendHeight: "10524728",
      sendTx: "50D0FE93ECCF1A9CB7212B38C898F30CDA4E37F771F818C1D9B6AEF558BF21A1",
    });
  });

  it("records an acknowledgement against the outbound packet (10524171)", () => {
    const [p] = at(10524171).ibcPackets;
    expect(p).toMatchObject({
      direction: "out",
      srcChannel: "channel-2",
      sequence: "114476",
      ackHeight: "10524171",
      ackOk: true,
      ackRelayer: "atone16vmp7sz28pnvgz6f3zm6q93y39jsd33a6ve2wc",
    });
  });

  it("records a receive keyed by the counterparty's source (10524863)", () => {
    const rows = at(10524863).ibcPackets;
    for (const p of rows) {
      expect(p).toMatchObject({ direction: "in", srcChannel: "channel-94814", sequence: "59069" });
    }
    expect(rows.some((p) => p.recvHeight === "10524863")).toBe(true);
  });

  it("records the relayer as a party", () => {
    const r = at(10524863).txParties.find((p) => p.address === "atone16vmp7sz28pnvgz6f3zm6q93y39jsd33a6ve2wc")!;
    expect(r.roles & ROLE.relayer).toBeTruthy();
  });
});

describe("staking", () => {
  it("records a redelegation with both validators (10523261)", () => {
    const out = at(10523261);
    expect(out.stakingEvents).toEqual([
      expect.objectContaining({
        kind: "redelegate",
        validator: "atonevaloper1wez3ehdwxfygeeu2lj44swcdpds08t3pgnlwc8",
        validatorDst: "atonevaloper17gysx6p6ggvjfgntpv0vsje3xkqc8ddmlnmxwd",
        delegator: "atone1n9gugf0w3kgkrv43zrqh630j3c0n224fdefjmh",
        amount: "1969000000",
        denom: "uatone",
        msgIndex: 0,
      }),
    ]);
    expect(out.validatorPower).toEqual([
      expect.objectContaining({ consAddr: "107F15D2309F65AA9DAB2E0D23BAAD3F75F50979", power: "3782533" }),
    ]);
  });

  it("drops the empty reward the SDK reports as 0stake", () => {
    expect(at(10523261).transfers.filter((t) => t.kind === "reward")).toEqual([]);
  });
});

describe("governance", () => {
  it("records a submission with its deposit (9148971)", () => {
    const out = at(9148971);
    expect(out.govProposals).toEqual([
      expect.objectContaining({
        proposalId: "21",
        submitHeight: "9148971",
        proposer: "atone10jzj3jjd3frna0ay08sh4zu4fpy957s4wx7yys",
        messages: ["/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade"],
      }),
    ]);
    expect(out.govDeposits).toEqual([
      expect.objectContaining({ proposalId: "21", coins: [{ amount: "51200000", denom: "uatone" }] }),
    ]);
    const p = out.txParties[0];
    expect(p.roles & ROLE.proposer).toBeTruthy();
    expect(p.roles & ROLE.depositor).toBeTruthy();
  });

  it("records the outcome from end-block events (9463929)", () => {
    expect(at(9463929).govProposals).toEqual([
      expect.objectContaining({ proposalId: "21", outcome: "passed", outcomeHeight: "9463929" }),
    ]);
  });
});

describe("finding 7: double signs and unjails", () => {
  it("tombstones on a double sign whose jail comes in a second slash event (1663342)", () => {
    const out = at(1663342);
    const addr = "atonevalcons1vk4k6xmy0wefd5t8fqvjy27d5sw2usccw2e36e";
    expect(out.slashes.map((s) => [s.kind, s.consAddr, s.reason, s.burned])).toEqual([
      ["slashed", addr, "double_sign", "2722050000"],
      ["tombstoned", addr, "double_sign", null],
    ]);
  });

  it("drops the tombstoned validator's power to zero", () => {
    expect(at(1663342).validatorPower.some((v) => v.power === "0")).toBe(true);
  });

  it("records an unjail from the message, since its event names only the account (9968835)", () => {
    const out = at(9968835);
    expect(out.slashes).toEqual([
      expect.objectContaining({ kind: "unjailed", operator: "atonevaloper10nnweapu0gqyj0zzw45w7vg58yc4aagwkmnx7x" }),
    ]);
    expect(out.txParties.map((p) => p.address)).toContain(
      "atonevaloper10nnweapu0gqyj0zzw45w7vg58yc4aagwkmnx7x"
    );
  });
});
