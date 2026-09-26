import { describe, expect, it } from "vitest";
import { symbolForBase, inferExponent } from "@/lib/ibc";

describe("symbolForBase", () => {
  it("strips the micro prefix from standard denoms", () => {
    // Verified live: ibc/14F9…11CC on cosmoshub resolves to base "uosmo".
    expect(symbolForBase("uosmo")).toBe("OSMO");
    expect(symbolForBase("uatom")).toBe("ATOM");
  });

  it("strips the atto prefix used by EVM-style chains", () => {
    expect(symbolForBase("aevmos")).toBe("EVMOS");
  });

  it("keeps contract and factory origin visible, never a native-looking ticker", () => {
    expect(symbolForBase("cw20:juno1abcdef123456")).toBe("CW20 123456");
    // A factory token named "uatom" must not render as ATOM or UATOM.
    expect(symbolForBase("factory/osmo1abc/uatom")).toBe("factory/uatom");
  });

  it("names liquid-staking derivatives and Terra Classic's dollar", () => {
    expect(symbolForBase("stuosmo")).toBe("stOSMO");
    expect(symbolForBase("staevmos")).toBe("stEVMOS");
    expect(symbolForBase("uusd")).toBe("USTC");
    expect(symbolForBase("stake")).toBe("STAKE");
    expect(symbolForBase("stinj")).toBe("stINJ");
    expect(symbolForBase("aISLM")).toBe("ISLM");
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

describe("inferExponent", () => {
  it("reads decimals from the denom's shape, or admits it cannot", () => {
    expect(inferExponent("uusdc")).toBe(6);
    expect(inferExponent("aevmos")).toBe(18);
    expect(inferExponent("stuatom")).toBe(6);
    expect(inferExponent("inj")).toBe(18);
    expect(inferExponent("stinj")).toBe(18);
    expect(inferExponent("aISLM")).toBe(18);
    expect(inferExponent("factory/osmo1abc/uhava")).toBe(6);
    expect(inferExponent("cw20:neutron1xyz")).toBeNull();
    expect(inferExponent("gravity0xabc")).toBeNull();
  });
});
