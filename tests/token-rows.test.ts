import { describe, expect, test } from "vitest";
import { tokenTransferRows } from "@/app/[chain]/accounts/[addr]/token-rows";
import type { GnoToken } from "@/lib/gno-tokens";

const token = {
  key: "gno.land/r/gnoswap/gns.GNS.0000000",
  realm: "gno.land/r/gnoswap/gns",
  name: "Gnoswap",
  symbol: "GNS",
  decimals: 6,
} as GnoToken;
const tokens = new Map([[token.key, token]]);
const t = (from: string, to: string, amount: string) => ({ txHash: "AB", height: 7, token: token.key, from, to, amount });

describe("an account's token transfers", () => {
  test("direction and sign from the account's side", () => {
    const rows = tokenTransferRows(
      "gnoland-1",
      "g1me",
      [t("g1you", "g1me", "1500000"), t("g1me", "g1you", "250000"), t("", "g1me", "1000000"), t("g1me", "", "1")],
      tokens,
      { byAddress: new Map([["g1you", "you"]]), byName: new Map([["you", "g1you"]]) },
      new Map()
    );
    expect(rows.map((r) => r.cells[1].v)).toEqual(["In", "Out", "Mint", "Burn"]);
    expect(rows.map((r) => r.cells[3].v)).toEqual(["+1.5", "-0.25", "+1", "-0.000001"]);
    expect(rows[0].cells[2]).toMatchObject({ v: "@you", address: "g1you" });
    expect(rows[0].cells[0]).toMatchObject({ v: "GNS", href: "/gnoland-1/tokens/r/gnoswap/gns/GNS" });
  });
});
