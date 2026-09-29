import { describe, it, expect } from "vitest";
import { getAllChains, chainDenoms } from "@/lib/chains";

describe("chain order", () => {
  // The order is a product decision, not a property of the chains — ours first,
  // then the rest, with each testnet next to its mainnet. Nothing derives it, so
  // only this test stops a new config file or a changed sort from quietly
  // rearranging the switcher.
  it("lists chains in the configured order", () => {
    expect(getAllChains().map((c) => c.chainId)).toEqual([
      "gnoland-1",
      "onyx-1",
      "atomone-1",
      "atomone-testnet-1",
      "cosmoshub-4",
      "provider",
      "akashnet-2",
      "osmosis-1",
      "passage-2",
      "juno-1",
    ]);
  });

  it("gives every chain an explicit order", () => {
    for (const chain of getAllChains()) {
      expect(chain.order, `${chain.chainId} has no order`).toBeTypeOf("number");
    }
  });

  it("sorts a chain with no order to the end rather than dropping it", () => {
    const chains = getAllChains();
    expect(chains).toHaveLength(10);
    expect(new Set(chains.map((c) => c.order)).size).toBe(10);
  });
});

describe("chainDenoms", () => {
  // AtomOne issues PHOTON for fees alongside ATONE for staking. Matching on the
  // staking denom alone left a PHOTON balance labelled "uphoton" and printed
  // unscaled, which is what this guards.
  it("includes the fee token as well as the staking token", () => {
    const atomone = getAllChains().find((c) => c.chainId === "atomone-1")!;
    const denoms = chainDenoms(atomone);

    expect(denoms.map((d) => d.denom)).toEqual(["uatone", "uphoton"]);
    expect(denoms.map((d) => d.symbol)).toEqual(["ATONE", "PHOTON"]);
    for (const d of denoms) expect(d.exponent).toBe(6);
  });

  it("lists one denom for a chain whose fee token is its staking token", () => {
    const hub = getAllChains().find((c) => c.chainId === "cosmoshub-4")!;
    expect(chainDenoms(hub).map((d) => d.symbol)).toEqual(["ATOM"]);
  });
});
