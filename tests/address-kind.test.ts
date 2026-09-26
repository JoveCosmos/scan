import { describe, expect, it } from "vitest";
import {
  parseAuthAccount,
  payloadLength,
  isUserKey,
  escrowAddress,
  escrowChannel,
} from "@/lib/address-kind";
import { formatUnits, sumUnits } from "@/lib/format";
import { searchQueries } from "@/lib/accounts";

describe("parseAuthAccount", () => {
  it("reads a module account's name and nested account number", () => {
    // Shape verified live: /cosmos/auth/v1beta1/accounts/cosmos1jv65s3… on cosmoshub-4.
    const facts = parseAuthAccount({
      "@type": "/cosmos.auth.v1beta1.ModuleAccount",
      base_account: { address: "x", pub_key: null, account_number: "25183", sequence: "0" },
      name: "distribution",
      permissions: ["basic"],
    });
    expect(facts.accountNumber).toBe("25183");
    expect(facts.sequence).toBe("0");
    expect(facts.kind).toEqual({ kind: "module", name: "distribution", permissions: ["basic"] });
  });

  it("reads a vesting account's schedule through base_vesting_account", () => {
    const facts = parseAuthAccount({
      "@type": "/cosmos.vesting.v1beta1.ContinuousVestingAccount",
      base_vesting_account: {
        base_account: { account_number: "7", sequence: "3", pub_key: { key: "k" } },
        original_vesting: [{ denom: "uatom", amount: "1000" }],
        delegated_vesting: [],
        end_time: "1893456000",
      },
      start_time: "1735689600",
    });
    expect(facts.accountNumber).toBe("7");
    expect(facts.hasPubKey).toBe(true);
    expect(facts.kind?.kind).toBe("vesting");
    if (facts.kind?.kind === "vesting") {
      expect(facts.kind.schedule).toBe("Continuous");
      expect(facts.kind.endTime).toBe("2030-01-01T00:00:00.000Z");
      expect(facts.kind.original).toEqual([{ denom: "uatom", amount: "1000" }]);
    }
  });

  it("reads a plain account at the top level", () => {
    const facts = parseAuthAccount({
      "@type": "/cosmos.auth.v1beta1.BaseAccount",
      account_number: "12",
      sequence: "78",
      pub_key: { key: "k" },
    });
    expect(facts.accountNumber).toBe("12");
    expect(facts.sequence).toBe("78");
    expect(facts.kind).toBeNull();
  });
});

describe("address bytes and keys", () => {
  it("tells a 20-byte key from a 32-byte contract", () => {
    expect(payloadLength("cosmos1q6wmlxmm88whf2c0md89236t4n9zpaqgcreua4")).toBe(20);
    expect(
      payloadLength("juno15u3dt79t6sxxa3x3kpkhzsy56edaa5a66wvt3kxmukqjz2sx0hes5sn38g")
    ).toBe(32);
    expect(isUserKey("juno15u3dt79t6sxxa3x3kpkhzsy56edaa5a66wvt3kxmukqjz2sx0hes5sn38g", null)).toBe(false);
    expect(
      isUserKey("cosmos1jv65s3grqf6v6jl3dp4t6c9t9rk99cd88lyufl", {
        kind: "module",
        name: "distribution",
        permissions: [],
      })
    ).toBe(false);
  });

  it("derives the ICS-20 escrow address and finds its channel", () => {
    // The Cosmos Hub escrow for channel-141, as seen live on the account page.
    expect(escrowAddress("cosmos", "channel-141")).toBe(
      "cosmos1x54ltnyg88k0ejmk8ytwrhd3ltm84xehrnlslf"
    );
    expect(escrowChannel("cosmos1x54ltnyg88k0ejmk8ytwrhd3ltm84xehrnlslf", "cosmos")).toBe(
      "channel-141"
    );
    expect(escrowChannel("cosmos1q6wmlxmm88whf2c0md89236t4n9zpaqgcreua4", "cosmos")).toBeNull();
  });
});

describe("formatUnits", () => {
  it("scales exactly with BigInt, beyond what a double holds", () => {
    expect(formatUnits("537818905004068240000", 18)).toBe("537.81890500406824");
    expect(formatUnits("999999997125000000", 6)).toBe("999,999,997,125");
    expect(formatUnits("18855", 6)).toBe("0.018855");
    expect(formatUnits("5", 6)).toBe("0.000005");
  });

  it("shows base units when the decimals are unknown", () => {
    expect(formatUnits("244173244326307", null)).toBe("244,173,244,326,307");
  });

  it("sums without precision loss", () => {
    expect(sumUnits(["9007199254740993", "1", undefined, "x"])).toBe("9007199254740994");
  });
});

describe("searchQueries", () => {
  it("never asks message.sender of a module account", () => {
    const q = searchQueries("cosmos1jv65s3grqf6v6jl3dp4t6c9t9rk99cd88lyufl", "module");
    expect(q.some((x) => x.startsWith("message.sender"))).toBe(false);
  });

  it("finds a contract by its wasm events", () => {
    expect(searchQueries("juno1x", "contract")[0]).toBe("wasm._contract_address='juno1x'");
  });
});
