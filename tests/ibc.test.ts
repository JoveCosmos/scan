import { describe, expect, it } from "vitest";
import { symbolForBase } from "@/lib/ibc";

describe("symbolForBase", () => {
  it("strips the micro prefix from standard denoms", () => {
    // Verified live: ibc/14F9…11CC on cosmoshub resolves to base "uosmo".
    expect(symbolForBase("uosmo")).toBe("OSMO");
    expect(symbolForBase("uatom")).toBe("ATOM");
  });

  it("strips the atto prefix used by EVM-style chains", () => {
    expect(symbolForBase("aevmos")).toBe("EVMOS");
  });

  it("labels contract and factory denoms rather than mangling them", () => {
    expect(symbolForBase("cw20:juno1abc")).toBe("CW20");
    expect(symbolForBase("factory/osmo1abc/ufoo")).toBe("UFOO");
  });

  it("leaves an unrecognised base recognisable instead of empty", () => {
    // A two-letter denom must not be mistaken for a micro prefix and reduced to
    // a single character.
    expect(symbolForBase("ux")).toBe("UX");
    expect(symbolForBase("gravity0xb2cABf797bc907B049e4cCB5b84d13be3a8CFC21")).toBe(
      "GRAVITY0XB2C"
    );
  });
});
