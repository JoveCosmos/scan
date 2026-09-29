import { describe, expect, it } from "vitest";
import { routeAddress, gnoPathHref } from "@/lib/address-route";

const chains = [
  { chainId: "cosmoshub-4", bech32Prefix: "cosmos", network: "mainnet" as const },
  { chainId: "provider", bech32Prefix: "cosmos", network: "testnet" as const },
  { chainId: "osmosis-1", bech32Prefix: "osmo", network: "mainnet" as const },
  { chainId: "gnoland-1", bech32Prefix: "g", network: "mainnet" as const },
  { chainId: "onyx-1", bech32Prefix: "g", network: "testnet" as const },
];

describe("routeAddress", () => {
  it("sends an operator address to the validator page, not /accounts", () => {
    const r = routeAddress("cosmosvaloper1n229vhepft6wnkt5tjpwmxdmcnfz55jv3vp77d", "cosmoshub-4", chains);
    expect(r?.href).toBe("/cosmoshub-4/validators/cosmosvaloper1n229vhepft6wnkt5tjpwmxdmcnfz55jv3vp77d");
    expect(r?.kind).toBe("validator");
  });

  it("sends a foreign prefix to its own chain", () => {
    const r = routeAddress("osmo1rsta2kjgn4sd5p7k0ysgttxedneqwc8eqdpc9v", "cosmoshub-4", chains);
    expect(r?.href).toBe("/osmosis-1/accounts/osmo1rsta2kjgn4sd5p7k0ysgttxedneqwc8eqdpc9v");
  });

  it("keeps a shared prefix on the current chain, else prefers mainnet", () => {
    const a = "cosmos1q6wmlxmm88whf2c0md89236t4n9zpaqgcreua4";
    expect(routeAddress(a, "provider", chains)?.chainId).toBe("provider");
    expect(routeAddress(a, "osmosis-1", chains)?.chainId).toBe("cosmoshub-4");
  });

  it("lower-cases input and routes consensus addresses to validators", () => {
    const r = routeAddress("COSMOS1Q6WMLXMM88WHF2C0MD89236T4N9ZPAQGCREUA4", "cosmoshub-4", chains);
    expect(r?.address).toBe("cosmos1q6wmlxmm88whf2c0md89236t4n9zpaqgcreua4");
  });

  it("returns null for prefixes we do not carry and for junk", () => {
    expect(routeAddress("inj1l62elesw6lw9w5ctqpwv0apkeghppr5d2mdqwh", "cosmoshub-4", chains)).toBeNull();
    expect(routeAddress("notanaddress", "cosmoshub-4", chains)).toBeNull();
  });

  it("links gno realm paths to gno.land", () => {
    expect(gnoPathHref("gno.land/r/gnoswap/router")).toBe("https://gno.land/r/gnoswap/router");
    expect(gnoPathHref("not a path")).toBeNull();
  });
});
