import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { extractGno, gnoTxFields, GNO_EXTRACT_VERSION, type GnoBlockIn, type GnoTxIn } from "../indexer/src/gno";

/**
 * gno extract version 6: the coins each message sends (gno_tx_msg.coins and .ugnot). Real blocks as gnoland-1's
 * tx-indexer served them (the v5 fixtures: the query already asked for a send's amount and a call's send).
 */
const fx = (h: number) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `gno-v5-gnoland-1-${h}.json`), "utf8")) as { blocks: GnoBlockIn[]; txs: GnoTxIn[] };
const at = (h: number) => { const d = fx(h); return extractGno(d.blocks, d.txs); };
const tx = (v: Record<string, unknown>): GnoTxIn =>
  ({ index: 0, hash: Buffer.alloc(32, 7).toString("base64"), success: true, block_height: 9, gas_wanted: 1, gas_used: 1, memo: "",
     gas_fee: null, messages: [{ typeUrl: "x", route: "x", value: v }] } as unknown as GnoTxIn);
const block = (txs: number): GnoBlockIn => ({ hash: "h", height: 9, time: "2026-11-15T00:00:00Z", num_txs: txs, chain_id: "gnoland-1" } as unknown as GnoBlockIn);
const one = (v: Record<string, unknown>) => extractGno([block(1)], [tx(v)]).msgs[0];

describe("version", () => {
  it("is 6", () => expect(GNO_EXTRACT_VERSION).toBe(6));
});

describe("sends (gnoland-1 113002)", () => {
  it("keep each send's amount, and its ugnot as a number", () => {
    expect(at(113002).msgs.map((m) => [m.kind, m.coins, m.ugnot])).toEqual([
      ["send", "3297800400ugnot", "3297800400"],
      ["send", "292000000ugnot", "292000000"],
      ["send", "99989000ugnot", "99989000"],
    ]);
  });
});

describe("calls (gnoland-1 339064)", () => {
  it("keep what a call sends with it, and none for a call that sends nothing", () => {
    expect(at(339064).msgs.map((m) => [m.func, m.coins, m.ugnot])).toEqual([
      ["Approve", null, null],
      ["Deposit", "3540000ugnot", "3540000"],
      ["ExactInSwapRoute", null, null],
    ]);
  });
});

describe("the coin text", () => {
  it("sums the ugnot of a list, and keeps a list with none", () => {
    expect(one({ __typename: "MsgCall", caller: "g1x", send: "5ugnot,7/gno.land/r/x:y,3ugnot", pkg_path: "gno.land/r/x", func: "F" }))
      .toMatchObject({ coins: "5ugnot,7/gno.land/r/x:y,3ugnot", ugnot: "8" });
    expect(one({ __typename: "MsgRun", caller: "g1x", send: "7/gno.land/r/x:y" })).toMatchObject({ coins: "7/gno.land/r/x:y", ugnot: null });
  });
  it("keeps a deployment's send", () => {
    expect(one({ __typename: "MsgAddPackage", creator: "g1x", package: { path: "gno.land/r/x" }, send: "1000000ugnot" }))
      .toMatchObject({ kind: "addpkg", coins: "1000000ugnot", ugnot: "1000000" });
  });
  it("stores nothing it cannot read as coins, and is exact past 2^53", () => {
    expect(one({ __typename: "MsgCall", caller: "g1x", send: "ugnot", pkg_path: "gno.land/r/x", func: "F" })).toMatchObject({ coins: null, ugnot: null });
    expect(one({ __typename: "MsgCall", caller: "g1x", send: "<b>1</b>", pkg_path: "gno.land/r/x", func: "F" })).toMatchObject({ coins: null });
    expect(one({ __typename: "BankMsgSend", from_address: "g1x", to_address: "g1y", amount: "90071992547409930ugnot" }))
      .toMatchObject({ ugnot: "90071992547409930" });
  });
});

describe("the query", () => {
  it("asks for a deployment's send only where the tx-indexer's schema has it", () => {
    expect(gnoTxFields(["MsgAddPackage"], [])).toContain("... on MsgAddPackage{ creator package{ path } }");
    expect(gnoTxFields(["MsgAddPackage"], [], { MsgAddPackage: ["creator", "package", "send"] }))
      .toContain("... on MsgAddPackage{ creator package{ path } send }");
  });
});
