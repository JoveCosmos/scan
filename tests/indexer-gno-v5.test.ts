import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractGno, gnoTxFields, gnoWindow, realmOf, GnoSource, ARG_MAX, GNO_EXTRACT_VERSION, type GnoBlockIn, type GnoTxIn,
} from "../indexer/src/gno";

/**
 * gno extract version 5: one row per message, GRC20 tokens and transfers, and genesis. Real blocks as gnoland-1's
 * tx-indexer served them to the extractor's own query (args and run paths included).
 */
const fx = (h: number) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `gno-v5-gnoland-1-${h}.json`), "utf8")) as { blocks: GnoBlockIn[]; txs: GnoTxIn[] };
const at = (h: number) => { const d = fx(h); return extractGno(d.blocks, d.txs); };
const kinds = (x: ReturnType<typeof at>) => x.msgs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});

const WUGNOT = "gno.land/r/gnoland/wugnot.wugnot.0000000";
const GNS = "gno.land/r/gnoswap/gns.GNS.0000000";

describe("genesis (gnoland-1 height 0)", () => {
  const x = at(0);
  it("is a block like any other, at the gno version, with its 96 transactions", () => {
    expect(x.blocks).toEqual([expect.objectContaining({ height: "0", txCount: 96, version: GNO_EXTRACT_VERSION })]);
    expect(x.txs).toHaveLength(96);
  });
  it("records every message: the packages deployed, the runs and calls of genesis", () => {
    expect(kinds(x)).toEqual({ addpkg: 89, run: 2, call: 5 });
    expect(x.msgs.find((m) => m.pkgPath === "gno.land/p/nt/ufmt/v0")).toMatchObject({
      kind: "addpkg", msgIndex: 0, height: "0", success: true, caller: "g1edq4dugw0sgat4zxcw9xardvuydqf6cgleuc8p", func: null, args: null,
    });
  });
  it("creates wugnot, with its realm", () => {
    expect(x.tokens).toEqual([{ token: WUGNOT, realm: "gno.land/r/gnoland/wugnot", name: "wrapped GNOT", symbol: "wugnot",
                                decimals: 0, height: "0", txHash: expect.stringMatching(/^[0-9A-F]{64}$/) }]);
    expect(x.transfers).toEqual([]);
  });
});

describe("a run (gnoland-1 36170)", () => {
  it("has its caller, and no path: the chain assigns a run's path, the transaction names none", () => {
    expect(at(36170).msgs).toEqual([expect.objectContaining({ kind: "run", pkgPath: null, func: null, args: null,
                                                               caller: "g1aeddlftlfk27ret5rf750d7w5dume3kcsm8r8m" })]);
  });
});

describe("GNS enabled and minted (gnoland-1 77259)", () => {
  const x = at(77259);
  it("records the approval as enable, not as a call", () => {
    expect(kinds(x)).toEqual({ addpkg: 1, enable: 1 });
    expect(x.msgs.find((m) => m.kind === "enable")).toMatchObject({ pkgPath: "gno.land/r/gnoswap/gns", caller: "g1yaaa6rcp4ew5yjzdj4yms596wx2dtrj3a86704" });
  });
  it("creates the token from NewToken", () => {
    expect(x.tokens).toEqual([expect.objectContaining({ token: GNS, realm: "gno.land/r/gnoswap/gns", name: "Gnoswap", symbol: "GNS", decimals: 6, height: "77259" })]);
  });
  it("mints from an empty sender, each at its place among the transaction's events", () => {
    expect(x.transfers).toEqual([
      expect.objectContaining({ token: GNS, from: "", to: "g1y7h659patawdy99mlufj9lp3t9cwpt8fq852zq", amount: "50000000000000", eventIndex: 2 }),
      expect.objectContaining({ token: GNS, from: "", to: "g1plxd74hnxyjvh309nfcndp53ypvv93yp5rd7dk", amount: "50000000000000", eventIndex: 3 }),
    ]);
  });
});

describe("a GRC721 collection (gnoland-1 77261)", () => {
  it("is not a GRC20 token, though it emits a NewToken too", () => {
    const x = at(77261);
    expect(x.tokens).toEqual([]);
    expect(x.transfers).toEqual([]);
  });
});

describe("an unwrap (gnoland-1 85424)", () => {
  const x = at(85424);
  it("is a call with its function and arguments", () => {
    expect(x.msgs).toEqual([expect.objectContaining({ kind: "call", pkgPath: "gno.land/r/gnoland/wugnot", func: "Withdraw",
                                                       args: ["2973101272"], caller: "g1pp6rhcqgeag6vd5swugznclk49284kxuhx6qq6" })]);
  });
  it("burns to an empty recipient", () => {
    expect(x.transfers).toEqual([expect.objectContaining({ token: WUGNOT, from: "g1pp6rhcqgeag6vd5swugznclk49284kxuhx6qq6", to: "", amount: "2973101272" })]);
  });
});

describe("sends beside a session message (gnoland-1 113002)", () => {
  it("records the sends and leaves out create_session (the tx-indexer's UnexpectedMessage)", () => {
    const d = fx(113002), x = at(113002);
    expect(d.txs.flatMap((t) => (t.messages ?? []).map((m) => m.value.__typename))).toContain("UnexpectedMessage");
    expect(kinds(x)).toEqual({ send: 3 });
    expect(x.txs).toHaveLength(4);
  });
});

describe("a failed batch of calls (gnoland-1 339064)", () => {
  const x = at(339064);
  it("keeps each message, in order, marked failed", () => {
    expect(x.msgs.map((m) => [m.msgIndex, m.kind, m.pkgPath, m.func, m.success])).toEqual([
      [0, "call", "gno.land/r/gnoland/wugnot", "Approve", false],
      [1, "call", "gno.land/r/gnoland/wugnot", "Deposit", false],
      [2, "call", "gno.land/r/gnoswap/router", "ExactInSwapRoute", false],
    ]);
  });
  it("moves no token", () => {
    expect(x.tokens).toEqual([]);
    expect(x.transfers).toEqual([]);
  });
});

describe("the extraction's edges", () => {
  const block: GnoBlockIn = { hash: "", height: 9, time: "2026-10-16T00:00:00Z", num_txs: 1, chain_id: "t" };
  const tx = (over: Partial<GnoTxIn>): GnoTxIn => ({
    index: 0, hash: Buffer.alloc(32, 7).toString("base64"), success: true, block_height: 9, gas_wanted: 1, gas_used: 1, memo: "",
    gas_fee: null, messages: [], response: { error: null, events: [] }, ...over,
  });
  it("cuts a long argument, marks the cut, and drops NUL", () => {
    const long = "x".repeat(ARG_MAX + 50);
    const x = extractGno([block], [tx({ messages: [{ typeUrl: "exec", route: "vm", value: {
      __typename: "MsgCall", caller: "g1pp6rhcqgeag6vd5swugznclk49284kxuhx6qq6", pkg_path: "gno.land/r/x", func: "F", send: "", args: [long, "a\u0000b"] } }] })]);
    expect(x.msgs[0].args).toEqual(["x".repeat(ARG_MAX) + "…", "ab"]);
  });
  it("skips a transfer whose value is not a whole number, and every event of another package", () => {
    const ev = (pkg: string, attrs: [string, string][]) =>
      ({ __typename: "GnoEvent", type: "Transfer", pkg_path: pkg, attrs: attrs.map(([key, value]) => ({ key, value })) });
    const x = extractGno([block], [tx({ response: { error: null, events: [
      ev("gno.land/p/nt/grc20/v0", [["token", "gno.land/r/a.A.0000000"], ["from", ""], ["to", "g1x"], ["value", "-5"]]),
      ev("gno.land/p/nt/grc721/v0", [["token", "gno.land/r/n.N.0000000"], ["from", ""], ["to", "g1x"], ["value", "5"]]),
      ev("gno.land/p/nt/grc20/v0", [["token", "gno.land/r/a.A.0000000"], ["from", "g1y"], ["to", "g1x"], ["value", "5"]]),
    ] } })]);
    expect(x.transfers).toEqual([expect.objectContaining({ eventIndex: 2, from: "g1y", to: "g1x", amount: "5" })]);
  });
});

describe("realmOf", () => {
  it("takes the symbol and the sequence off the token key", () => {
    expect(realmOf(GNS, "GNS")).toBe("gno.land/r/gnoswap/gns");
    expect(realmOf("gno.land/r/g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt/gnomi/padv3.PONZI.000000a", "PONZI"))
      .toBe("gno.land/r/g1n4pl5uc4yt5r96m9w6fmdznx3x0jyg8l6arhmt/gnomi/padv3");
    expect(realmOf("gno.land/r/x/y.A.B.0000001", "A.B")).toBe("gno.land/r/x/y");
    expect(realmOf("gno.land/r/x/y.Z.0000001", null)).toBe("gno.land/r/x/y");
    expect(realmOf("no-sequence", "X")).toBeNull();
  });
});

describe("the query", () => {
  it("asks for args and a run's path only where the tx-indexer's schema has them", () => {
    const types = ["MsgCall", "MsgRun"];
    expect(gnoTxFields(types, ["GnoEvent"])).not.toContain("args");
    const q = gnoTxFields(types, ["GnoEvent"], { MsgCall: ["caller", "args"], MsgRun: ["caller", "package"] });
    expect(q).toContain("... on MsgCall{ caller send pkg_path func args }");
    expect(q).toContain("... on MsgRun{ caller send package{ path } }");
  });
  it("bounds a window that starts at genesis from above only (a negative gt returns nothing)", () => {
    expect(gnoWindow(0, 999)).toBe("{lt:1000}");
    expect(gnoWindow(1, 999)).toBe("{gt:0, lt:1000}");
    expect(gnoWindow(5000, 5999)).toBe("{gt:4999, lt:6000}");
  });
});

describe("a tx-indexer that refuses a window over its cap", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("splits the window until each part fits", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const query = JSON.parse(init.body).query as string;
      const json = (b: unknown) => ({ ok: true, json: async () => b });
      if (query.includes("__type(")) return json({ data: { m: { possibleTypes: [{ name: "BankMsgSend" }] }, e: { possibleTypes: [] }, call: null, run: null } });
      const w = /block_height:(\{[^}]*\})/.exec(query)![1];
      asked.push(w);
      if (w === "{lt:4}") return json({ errors: [{ message: "max elements per query reached (10000)" }], data: { getTransactions: [] } });
      const lo = /gt:(-?\d+)/.exec(w), hi = Number(/lt:(\d+)/.exec(w)![1]) - 1;
      const from = lo ? Number(lo[1]) + 1 : 0;
      return json({ data: { getTransactions: Array.from({ length: hi - from + 1 }, (_, i) => ({ block_height: from + i })) } });
    });
    const rows = await new GnoSource("http://tx-indexer").txs(0, 3);
    expect(rows.map((r) => r.block_height)).toEqual([0, 1, 2, 3]);
    expect(asked).toEqual(["{lt:4}", "{lt:2}", "{gt:1, lt:4}"]);
  });
});
