import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractGno, gnoTxFields, hexHash, GNO_ROLE, GNO_EXTRACT_VERSION, type GnoBlockIn, type GnoTxIn } from "../indexer/src/gno";

/**
 * gno.land projection, against real blocks as our own tx-indexers served them
 * (captured with the extractor's own query): gnoland-1 and pearl-1.
 */
const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as { blocks: GnoBlockIn[]; txs: GnoTxIn[] };
const at = (chain: string, h: number) => { const d = fx(`gno-${chain}-${h}.json`); return extractGno(d.blocks, d.txs); };
const roles = (x: ReturnType<typeof at>) => Object.fromEntries(x.parties.map((p) => [p.address, p.roles]));

describe("hexHash", () => {
  it("turns the tx-indexer's base64 into the uppercase hex every other chain uses", () => {
    expect(hexHash("xSXOCt6fhOx3GcR5p5Q42DEA0nbikdsrMknKhukMuEM=")).toMatch(/^C525CE0ADE9F[0-9A-F]{52}$/);
    expect(hexHash("bm90IGEgaGFzaA==")).toBeNull();
  });
});

describe("a bank send (gnoland-1 337001)", () => {
  const x = at("gnoland-1", 337001);
  it("writes the block at the gno version, with its time and tx count", () => {
    expect(x.blocks).toEqual([expect.objectContaining({ height: "337001", txCount: 1, version: GNO_EXTRACT_VERSION })]);
    expect(x.blocks[0].time).toBe("2026-09-26T03:13:02.63714962Z");
  });
  it("records the transaction with fee, gas and type", () => {
    expect(x.txs).toEqual([expect.objectContaining({ height: "337001", txIndex: 0, success: true, msgTypes: ["BankMsgSend"],
      feeAmount: "1027", feeDenom: "ugnot", gasUsed: "936478", time: "2026-09-26T03:13:02.63714962Z", error: null })]);
  });
  it("makes the sender a signer and sender, the recipient a recipient", () => {
    expect(roles(x)).toEqual({
      g1juss2tuc97sr77rn6vprhh9lr7d9e07uu68x59: GNO_ROLE.signer | GNO_ROLE.sender,
      g19ulvh44r54nc44pekne4cy6e7lptheq7a0wavt: GNO_ROLE.recipient,
    });
  });
});

describe("a realm call batch with GRC20 transfers (gnoland-1 337213)", () => {
  const x = at("gnoland-1", 337213);
  it("lists every call", () => {
    expect(x.txs[0].msgTypes).toEqual(Array(10).fill("MsgCall"));
  });
  it("adds the addresses of GRC20 Transfer events, and skips a mint's empty from", () => {
    const r = roles(x);
    expect(r.g1eth25yr535x29p32wllelj09u5kaqw8d50vdst & GNO_ROLE.signer).toBeTruthy();
    expect(r.g177jkk4xx79uledh9xedqkq4ht4ef9t6amxwjeq).toBe(GNO_ROLE.sender | GNO_ROLE.recipient);
    expect(Object.keys(r)).not.toContain("");
    expect(Object.keys(r).length).toBe(7);
  });
});

describe("a failed transaction (gnoland-1 330527)", () => {
  const x = at("gnoland-1", 330527);
  it("keeps the transaction, marked failed, with the chain's error", () => {
    expect(x.txs[0]).toMatchObject({ success: false, msgTypes: ["MsgCall", "MsgCall"], error: expect.stringContaining("out of gas") });
  });
  it("names only the signer: a failed transaction's events describe nothing that happened", () => {
    expect(roles(x)).toEqual({ g13959x7zm49jaeyrfeltjkwz8adu8p0r0uhffag: GNO_ROLE.signer });
  });
});

describe("a call that moves coins (gnoland-1 334925)", () => {
  it("counts bank TransferEvents inside a call", () => {
    const r = roles(at("gnoland-1", 334925));
    expect(r.g16vsca65y205enmn3t3hvcvccdalvkgxqnmnuug).toBe(GNO_ROLE.signer | GNO_ROLE.sender | GNO_ROLE.recipient);
    expect(Object.values(r).filter((v) => v === GNO_ROLE.recipient)).toHaveLength(2);
  });
});

describe("a package deploy and a script run", () => {
  it("makes the deployer signer and creator (gnoland-1 336668)", () => {
    expect(roles(at("gnoland-1", 336668))).toEqual({ g1qp5pt8cdq2f6kfdamn3yuxwg6quqnfpyewzz39: GNO_ROLE.signer | GNO_ROLE.creator });
  });
  it("makes a MsgRun's caller the signer, on both chains", () => {
    expect(roles(at("gnoland-1", 160940))).toEqual({ g1manfred47kzduec920z88wfr64ylksmdcedlf5: GNO_ROLE.signer });
    expect(at("pearl-1", 597854).txs[0].msgTypes).toEqual(["MsgRun"]);
  });
});

describe("a block the tx-indexer holds incompletely", () => {
  it("is written hollow - version 0, no transactions, no parties - never claimed as covered", () => {
    const d = fx("gno-gnoland-1-337001.json");
    const x = extractGno([{ ...d.blocks[0], num_txs: 2 }], d.txs);
    expect(x.blocks[0].version).toBe(0);
    expect(x.hollow).toEqual([337001]);
    expect(x.txs).toEqual([]);
    expect(x.parties).toEqual([]);
  });
});

describe("the query", () => {
  it("names only the types the tx-indexer knows (pearl-1's has no TransferEvent)", () => {
    const q = gnoTxFields(["BankMsgSend", "MsgCall", "MsgAddPackage", "MsgRun", "UnexpectedMessage"], ["GnoEvent", "UnknownEvent"]);
    expect(q).not.toContain("TransferEvent");
    expect(q).not.toContain("MsgEnablePackage");
    expect(q).toContain("... on GnoEvent{");
  });
});
