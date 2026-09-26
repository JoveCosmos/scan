import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractBlock,
  parseCoins,
  txHash,
  blockEvents,
  parseVoteOptions,
  extractSlashes,
  type Event,
  type BlockResponse,
  type BlockResultsResponse,
} from "../indexer/src/extract";

/**
 * Verified against a real AtomOne block captured from the archive node, not an
 * invented shape. Height 9823288 carries one transaction with four reward
 * withdrawals, so it exercises fees, message types and multi-coin transfers.
 */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(__dirname, "fixtures", name), "utf8")
  );

const block = fixture("atomone-block-9823288.json") as BlockResponse;
const results = fixture(
  "atomone-block-results-9823288.json"
) as BlockResultsResponse;

/** Confirmed on chain: this hash resolves to height 9823288. */
const KNOWN_HASH =
  "91E52F87BA07943D60F839790A697B6CD9A39BFAB872BCBECF424988ED29D4CC";

describe("txHash", () => {
  it("derives the on-chain hash from a block's raw tx bytes", () => {
    // This is what lets the indexer run against a node with tx_index off.
    const raw = block.result!.block!.data!.txs![0];
    expect(txHash(raw)).toBe(KNOWN_HASH);
  });
});

describe("parseCoins", () => {
  it("splits a multi-denom amount", () => {
    expect(parseCoins("1461883uatone,2247uphoton")).toEqual([
      { amount: "1461883", denom: "uatone" },
      { amount: "2247", denom: "uphoton" },
    ]);
  });

  it("keeps ibc and factory denoms intact", () => {
    // Digits and slashes inside the denom must not be mistaken for the amount.
    expect(parseCoins("500ibc/1A2B3C")).toEqual([
      { amount: "500", denom: "ibc/1A2B3C" },
    ]);
    expect(parseCoins("7factory/osmo1abc/uf00")).toEqual([
      { amount: "7", denom: "factory/osmo1abc/uf00" },
    ]);
  });

  it("ignores empty and malformed entries", () => {
    expect(parseCoins("")).toEqual([]);
    expect(parseCoins("uatone")).toEqual([]);
  });
});

describe("extractBlock", () => {
  const out = extractBlock(block, results)!;

  it("reads the block header", () => {
    expect(out.block.height).toBe("9823288");
    expect(out.block.time).toBe("2026-08-09T22:13:32.188252722Z");
    expect(out.block.proposerCons).toBe("8A948A32DC693745146C2CD913815B166675809B");
    expect(out.block.txCount).toBe(1);
  });

  it("extracts the transaction with its fee and gas", () => {
    expect(out.txs).toHaveLength(1);
    const tx = out.txs[0];
    expect(tx.hash).toBe(KNOWN_HASH);
    expect(tx.code).toBe(0);
    // AtomOne pays fees in PHOTON, not the staking token.
    expect(tx.feeDenom).toBe("uphoton");
    expect(tx.feeAmount).toBe("220335");
    expect(tx.gasUsed).toBe("423921");
    expect(tx.gasWanted).toBe("612040");
    expect(tx.signer).toBe("atone1w6dpa2l2fc3v2rc9dpuhqg4lt6ykvlqgw02que");
  });

  it("records every message type in order", () => {
    // Four reward withdrawals in one transaction.
    expect(out.txs[0].msgTypes).toEqual(
      Array(4).fill("/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward")
    );
  });

  it("captures reward amounts, which the message itself does not carry", () => {
    const rewards = out.transfers.filter((t) => t.kind === "reward");
    expect(rewards.length).toBeGreaterThan(0);

    const first = rewards.find((r) => r.denom === "uatone")!;
    expect(first.amount).toBe("1461883");
    expect(first.toAddr).toBe("atone1w6dpa2l2fc3v2rc9dpuhqg4lt6ykvlqgw02que");
    expect(first.fromAddr).toMatch(/^atonevaloper1/);
  });

  it("separates the fee deduction from message transfers", () => {
    // The fee is deducted before any message runs, so it carries no msg_index.
    const fees = out.transfers.filter((t) => t.kind === "fee");
    expect(fees).toHaveLength(1);
    expect(fees[0].msgIndex).toBe(-1);
    expect(fees[0].denom).toBe("uphoton");
    expect(fees[0].amount).toBe("220335");
  });

  it("gives every transfer a unique key", () => {
    // Matches the table's key; a collision would silently drop a row.
    const keys = out.transfers.map(
      (t) => `${t.txHash}|${t.eventSeq}|${t.coinIndex}`
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stamps every row with the block's height and time", () => {
    for (const t of out.transfers) {
      expect(t.height).toBe("9823288");
      expect(t.time).toBe(out.block.time);
    }
  });

  it("returns null when the two responses disagree on height", () => {
    const mismatched = { result: { ...results.result, height: "999" } };
    expect(extractBlock(block, mismatched as BlockResultsResponse)).toBeNull();
  });

  it("handles an empty block", () => {
    const empty: BlockResponse = {
      result: {
        block: {
          header: { height: "1", time: "2024-01-01T00:00:00Z" },
          data: { txs: null },
        },
      },
    };
    const res = extractBlock(empty, { result: { height: "1" } })!;
    expect(res.block.txCount).toBe(0);
    expect(res.txs).toEqual([]);
    expect(res.transfers).toEqual([]);
  });
});

describe("blockEvents", () => {
  it("reads CometBFT 0.38 finalize_block_events", () => {
    const events = blockEvents(results);
    expect(events.length).toBeGreaterThan(0);
    // The liveness event is how downtime reaches the indexer in a later phase.
    expect(events.some((e) => e.type === "liveness")).toBe(true);
  });

  it("also reads the older begin/end split", () => {
    const old: BlockResultsResponse = {
      result: {
        height: "1",
        begin_block_events: [{ type: "slash" }],
        end_block_events: [{ type: "complete_unbonding" }],
      },
    };
    expect(blockEvents(old).map((e) => e.type)).toEqual([
      "slash",
      "complete_unbonding",
    ]);
  });
});

describe("abciResultsMissing", () => {
  it("is false on a healthy block", () => {
    expect(extractBlock(block, results)!.abciResultsMissing).toBe(false);
  });

  it("flags a block whose node dropped its ABCI responses", () => {
    // Exactly what an AtomOne node with discard_abci_responses returns: the
    // block still lists its transactions, but txs_results is null.
    const dropped: BlockResultsResponse = {
      result: { height: "9823288", txs_results: null },
    };
    const out = extractBlock(block, dropped)!;
    expect(out.abciResultsMissing).toBe(true);
    // The rows exist but are hollow: what the tx bytes carry (fee, sender)
    // is there, what only the results carry (gas used, transfers) is not.
    expect(out.extractVersion).toBe(0);
    expect(out.txs).toHaveLength(1);
    expect(out.txs[0].feeAmount).toBe("220335");
    expect(out.txs[0].signer).toBe("atone1w6dpa2l2fc3v2rc9dpuhqg4lt6ykvlqgw02que");
    expect(out.txs[0].gasUsed).toBeNull();
    expect(out.transfers).toEqual([]);
  });

  it("is false for an empty block, which legitimately has no results", () => {
    const empty: BlockResponse = {
      result: {
        block: {
          header: { height: "1", time: "2024-01-01T00:00:00Z" },
          data: { txs: null },
        },
      },
    };
    expect(extractBlock(empty, { result: { height: "1" } })!.abciResultsMissing).toBe(
      false
    );
  });
});

/**
 * Real AtomOne blocks, captured from the archive:
 *   9829661 — a validator jailed for downtime, with burned coins
 *   9463782 — a vote on proposal 21
 */
const slashBlock = fixture("atomone-block-9829661.json") as BlockResponse;
const slashResults = fixture(
  "atomone-block-results-9829661.json"
) as BlockResultsResponse;
const voteBlock = fixture("atomone-block-9463782.json") as BlockResponse;
const voteResults = fixture(
  "atomone-block-results-9463782.json"
) as BlockResultsResponse;

describe("parseVoteOptions", () => {
  it("parses the protobuf text form the event carries", () => {
    expect(
      parseVoteOptions('option:VOTE_OPTION_YES weight:"1.000000000000000000"')
    ).toEqual([{ option: "VOTE_OPTION_YES", weight: "1.000000000000000000" }]);
  });

  it("keeps every option of a split vote", () => {
    const raw =
      'option:VOTE_OPTION_YES weight:"0.600000000000000000" ' +
      'option:VOTE_OPTION_NO weight:"0.400000000000000000"';
    expect(parseVoteOptions(raw)).toEqual([
      { option: "VOTE_OPTION_YES", weight: "0.600000000000000000" },
      { option: "VOTE_OPTION_NO", weight: "0.400000000000000000" },
    ]);
  });

  it("accepts a bare enum from older chains", () => {
    expect(parseVoteOptions("VOTE_OPTION_ABSTAIN")).toEqual([
      { option: "VOTE_OPTION_ABSTAIN", weight: "1" },
    ]);
  });

  it("returns nothing for junk rather than inventing a vote", () => {
    expect(parseVoteOptions("")).toEqual([]);
    expect(parseVoteOptions("hello")).toEqual([]);
  });
});

describe("votes from a real block", () => {
  const out = extractBlock(voteBlock, voteResults)!;

  it("extracts the vote with its voter and option", () => {
    expect(out.votes).toHaveLength(1);
    const v = out.votes[0];
    expect(v.proposalId).toBe("21");
    expect(v.voter).toBe("atone1dsjpz9pydwadzd8pstlrakn9kg06fyk0s7z2p9");
    expect(v.option).toBe("VOTE_OPTION_YES");
    expect(v.weighted).toBe(false);
    expect(v.options).toBeNull();
  });

  it("ties the vote to its transaction and height", () => {
    expect(out.votes[0].height).toBe("9463782");
    expect(out.votes[0].txHash).toMatch(/^[0-9A-F]{64}$/);
  });

  it("takes the voter from the event, so authz votes attribute correctly", () => {
    // The event names the granter. Reading the signer instead would credit the
    // grantee — the bug that made Scan under-count AtomOne proposals.
    const voters = out.votes.map((v) => v.voter);
    for (const v of voters) expect(v.startsWith("atone1")).toBe(true);
  });
});

describe("slashes from a real block", () => {
  const out = extractBlock(slashBlock, slashResults)!;

  it("records the slash with its reason and burned amount", () => {
    const slashed = out.slashes.filter((s) => s.kind === "slashed");
    expect(slashed).toHaveLength(1);
    expect(slashed[0].consAddr).toBe(
      "atonevalcons1surx4dn7pqz8akv8nqmwtky7e7rsye92lrlpn4"
    );
    // The chain says "missing_signature"; we store the reader's word.
    expect(slashed[0].reason).toBe("downtime");
    expect(slashed[0].burned).toBe("4812300");
  });

  it("records the jailing as its own row", () => {
    // So "how many times jailed" is a row count, not a filter on a nullable.
    const jailed = out.slashes.filter((s) => s.kind === "jailed");
    expect(jailed).toHaveLength(1);
    expect(jailed[0].consAddr).toBe(
      "atonevalcons1surx4dn7pqz8akv8nqmwtky7e7rsye92lrlpn4"
    );
    expect(jailed[0].burned).toBeNull();
  });

  it("tombstones rather than jails on a double sign", () => {
    const doubleSign: Event[] = [
      {
        type: "slash",
        attributes: [
          { key: "address", value: "atonevalcons1abc" },
          { key: "reason", value: "double_sign" },
          { key: "jailed", value: "atonevalcons1abc" },
          { key: "burned_coins", value: "500" },
        ],
      },
    ];
    const rows = extractSlashes(doubleSign, "100", "2026-01-01T00:00:00Z");
    expect(rows.map((r) => r.kind).sort()).toEqual(["slashed", "tombstoned"]);
  });

  it("ignores liveness, which is a running counter not an event", () => {
    // One per validator per block would swamp the table at chain scale.
    const liveness: Event[] = [
      {
        type: "liveness",
        attributes: [
          { key: "address", value: "atonevalcons1abc" },
          { key: "missed_blocks", value: "8559" },
        ],
      },
    ];
    expect(extractSlashes(liveness, "100", "2026-01-01T00:00:00Z")).toEqual([]);
  });

  it("finds no slashes in an ordinary block", () => {
    expect(extractBlock(block, results)!.slashes).toEqual([]);
  });
});
