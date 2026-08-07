import { describe, it, expect } from "vitest";
import { classifyQuery, classifyChainless } from "@/lib/search";
import type { ChainConfig } from "@/lib/chains";

const cosmos = { bech32Prefix: "cosmos" } as ChainConfig;
const gno = { bech32Prefix: "g" } as ChainConfig;

describe("classifyQuery", () => {
  it("treats a bare number as a block height", () => {
    expect(classifyQuery(cosmos, "32203000")).toEqual({
      kind: "height",
      value: "32203000",
    });
  });

  it("normalises a cosmos hex hash to upper case", () => {
    const lower = "a".repeat(64);
    const guess = classifyQuery(cosmos, lower);
    expect(guess.kind).toBe("tx");
    expect(guess.value).toBe("A".repeat(64));
  });

  it("routes a valoper address to the validator page", () => {
    const addr = "cosmosvaloper1qphf0ferqcch0jca9hlqfm3x0eds3dpkcvpafp";
    expect(classifyQuery(cosmos, addr)).toEqual({ kind: "validator", value: addr });
  });

  it("routes an account address to the address branch", () => {
    const addr = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
    expect(classifyQuery(cosmos, addr).kind).toBe("address");
  });

  it("recognises a gno base64 tx hash", () => {
    const hash = "yXjLD2QsjBh8cx4do+w7jtFsnN0gA4sxZToczxbEZaU=";
    expect(classifyQuery(gno, hash).kind).toBe("tx");
  });

  it("does not mistake a g1 address for a base64 hash", () => {
    // Both start with "g"; address rules must win.
    const addr = "g18qhq2fl54lszhmxeyqlvxnwjzc3xpu4nnakclp";
    expect(classifyQuery(gno, addr).kind).toBe("address");
  });

  it("does not mistake a base64 hash starting with g1 for an address", () => {
    // Contrived but legal base64: starts g1, contains chars outside bech32.
    const hash = "g1I8dLTj3DV7m2+QGNik8swoN7KGRaOba+fQ7LRn86A=";
    expect(classifyQuery(gno, hash).kind).toBe("tx");
  });

  it("rejects free text and empty input", () => {
    expect(classifyQuery(cosmos, "hello world").kind).toBe("unknown");
    expect(classifyQuery(cosmos, "   ").kind).toBe("unknown");
  });

  it("trims surrounding whitespace from a pasted value", () => {
    expect(classifyQuery(cosmos, "  32203000  ")).toEqual({
      kind: "height",
      value: "32203000",
    });
  });

  it("does not classify another chain's address as this chain's", () => {
    // An atone address pasted on cosmoshub must not resolve as a local account.
    expect(classifyQuery(cosmos, "atone1z946llvyk5v2hatfha3xhgq5dd5mll53qr4w63").kind)
      .toBe("unknown");
  });
});

describe("classifyChainless", () => {
  it("recognises a block height without knowing the chain", () => {
    expect(classifyChainless("32203000")).toEqual({
      kind: "height",
      value: "32203000",
    });
  });

  it("recognises and upper-cases a Cosmos tx hash", () => {
    const lower = "a".repeat(64);
    expect(classifyChainless(lower)).toEqual({
      kind: "tx",
      value: "A".repeat(64),
    });
  });

  it("recognises a gno base64 tx hash", () => {
    expect(classifyChainless(`${"A".repeat(43)}=`).kind).toBe("tx");
  });

  it("does not classify an address, which needs a chain prefix", () => {
    // Addresses are resolved against every chain by the caller instead.
    expect(
      classifyChainless("cosmos1qphf0ferqcch0jca9hlqfm3x0eds3dpkzcqmvq").kind
    ).toBe("unknown");
  });

  it("agrees with the chain-aware classifier on heights and hashes", () => {
    for (const q of ["32203000", "b".repeat(64)]) {
      expect(classifyChainless(q)).toEqual(classifyQuery(cosmos, q));
    }
  });

  it("treats blank input as unknown", () => {
    expect(classifyChainless("   ").kind).toBe("unknown");
  });
});
