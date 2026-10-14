import { describe, expect, test } from "vitest";
import { applyGrc20, holderCount, holdersOf, tokenHref, type EventTx, type GnoToken } from "@/lib/gno-tokens";

const KEY = "gno.land/r/gnoswap/gns.GNS.0000000";
const ev = (type: string, attrs: Record<string, string>) => ({
  type,
  pkg_path: "gno.land/p/nt/grc20/v0",
  attrs: Object.entries(attrs).map(([key, value]) => ({ key, value })),
});
const tx = (height: number, ...events: ReturnType<typeof ev>[]): EventTx => ({
  hash: Buffer.alloc(32, height).toString("base64"),
  block_height: height,
  response: { events },
});

describe("GRC20 state from events", () => {
  test("mints, transfers and burns give balances and supply", () => {
    const state = { tokens: new Map<string, GnoToken>() };
    applyGrc20(state, [
      tx(5, ev("NewToken", { token: KEY, name: "Gnoswap", symbol: "GNS", decimals: "6" })),
      tx(6, ev("Transfer", { token: KEY, from: "", to: "g1a", value: "1000" })),
      tx(7, ev("Transfer", { token: KEY, from: "g1a", to: "g1b", value: "400" }), ev("Approval", { token: KEY })),
      tx(8, ev("Transfer", { token: KEY, from: "g1b", to: "", value: "400" })),
    ]);
    const t = state.tokens.get(KEY)!;
    expect(t.realm).toBe("gno.land/r/gnoswap/gns");
    expect(t.symbol).toBe("GNS");
    expect(t.decimals).toBe(6);
    expect(t.supply).toBe(BigInt(600));
    expect(holderCount(t)).toBe(1);
    expect(holdersOf(t)).toEqual([{ address: "g1a", balance: BigInt(600) }]);
    expect(t.transfers).toBe(3);
    expect(t.recent[0].to).toBe("");
    expect(tokenHref("gnoland-1", t)).toBe("/gnoland-1/tokens/r/gnoswap/gns/GNS");
  });

  test("events of other packages and unknown tokens are ignored", () => {
    const state = { tokens: new Map<string, GnoToken>() };
    applyGrc20(state, [
      tx(1, { ...ev("Transfer", { token: KEY, from: "", to: "g1a", value: "5" }) }),
      tx(2, { ...ev("NewToken", { token: KEY, symbol: "GNS" }), pkg_path: "gno.land/r/other" }),
    ]);
    expect(state.tokens.size).toBe(0);
  });
});
