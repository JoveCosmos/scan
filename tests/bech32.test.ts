import { describe, it, expect } from "vitest";
import {
  convertAddress,
  decodePrefix,
  linkedAddresses,
  accountFromOperator,
  linkedChains,
} from "@/lib/bech32";

const COSMOS = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";

describe("convertAddress", () => {
  it("re-encodes the same payload under a new prefix", () => {
    expect(convertAddress(COSMOS, "akash")).toBe(
      "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5jepelx"
    );
    expect(convertAddress(COSMOS, "g")).toBe("g1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5v7sa8c");
  });

  it("round-trips back to the original", () => {
    const atone = convertAddress(COSMOS, "atone")!;
    expect(convertAddress(atone, "cosmos")).toBe(COSMOS);
  });

  it("returns null rather than throwing on junk", () => {
    expect(convertAddress("not-an-address", "cosmos")).toBeNull();
    expect(convertAddress("", "cosmos")).toBeNull();
    // Correct bech32 shape, wrong checksum.
    expect(convertAddress("cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xz", "akash")).toBeNull();
  });
});

describe("decodePrefix", () => {
  it("reads the human-readable part", () => {
    expect(decodePrefix(COSMOS)).toBe("cosmos");
    expect(decodePrefix("g1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5v7sa8c")).toBe("g");
  });

  it("returns null for undecodable input", () => {
    expect(decodePrefix("hello")).toBeNull();
  });
});

describe("accountFromOperator", () => {
  const OP = "cosmosvaloper1qphf0ferqcch0jca9hlqfm3x0eds3dpkcvpafp";

  it("derives the validator's self-delegation account", () => {
    const account = accountFromOperator(OP, "cosmos")!;
    expect(account.startsWith("cosmos1")).toBe(true);
    // Same payload, so converting back reproduces the operator address.
    expect(convertAddress(account, "cosmosvaloper")).toBe(OP);
  });

  it("uses the chain's own prefix", () => {
    const op = convertAddress(OP, "atonevaloper")!;
    expect(accountFromOperator(op, "atone")!.startsWith("atone1")).toBe(true);
  });

  it("refuses a plain account address, which has no operator to unwrap", () => {
    expect(accountFromOperator(COSMOS, "cosmos")).toBeNull();
  });

  it("returns null for junk", () => {
    expect(accountFromOperator("nonsense", "cosmos")).toBeNull();
  });
});

describe("linkedAddresses", () => {
  it("returns the account on every linked chain, including its own", () => {
    const links = linkedAddresses(COSMOS);
    expect(links).toHaveLength(linkedChains().length);
    // Every mainnet we carry, Osmosis, Juno and Passage included.
    expect(links.map((l) => l.chainId)).toEqual(
      expect.arrayContaining([
        "cosmoshub-4",
        "atomone-1",
        "akashnet-2",
        "osmosis-1",
        "juno-1",
        "passage-2",
        "gnoland-1",
      ])
    );
    expect(links.some((l) => l.chainId === "provider")).toBe(false);
    expect(links.find((l) => l.chainId === "cosmoshub-4")!.address).toBe(COSMOS);
  });

  it("gives the same set whichever chain you start from", () => {
    const fromGno = linkedAddresses("g1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5v7sa8c");
    expect(fromGno.find((l) => l.chainId === "cosmoshub-4")!.address).toBe(COSMOS);
  });

  it("refuses validator operator addresses — a different namespace", () => {
    expect(
      linkedAddresses("cosmosvaloper1qphf0ferqcch0jca9hlqfm3x0eds3dpkcvpafp")
    ).toEqual([]);
  });

  it("returns nothing for junk instead of throwing", () => {
    expect(linkedAddresses("nonsense")).toEqual([]);
  });
});
