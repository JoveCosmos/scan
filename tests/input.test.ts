import { describe, expect, it } from "vitest";
import { isNumericId, isCosmosTxHash, isBech32ish } from "@/lib/input";

/**
 * The whitelist that keeps URL-supplied identifiers out of fetch paths.
 *
 * Two properties matter and both are pinned: nothing legitimate is rejected,
 * and the traversal shapes that motivated the module never pass. The second
 * half uses the actual attack strings - `decodeParam` has already
 * percent-decoded by the time these run, so the guards see raw `/` and `?`.
 */

describe("isNumericId", () => {
  it("accepts real heights and proposal ids", () => {
    expect(isNumericId("1")).toBe(true);
    expect(isNumericId("21")).toBe(true);
    expect(isNumericId("9836594")).toBe(true);
    expect(isNumericId(9836594)).toBe(true);
  });

  it("rejects traversal and query smuggling", () => {
    expect(isNumericId("1/../deposits")).toBe(false);
    expect(isNumericId("21?pagination.limit=100000")).toBe(false);
    expect(isNumericId("21#frag")).toBe(false);
    expect(isNumericId("")).toBe(false);
    expect(isNumericId("-1")).toBe(false);
    expect(isNumericId("1e6")).toBe(false);
  });
});

describe("isCosmosTxHash", () => {
  it("accepts a 64-char hex hash in either case", () => {
    expect(
      isCosmosTxHash("A".repeat(64))
    ).toBe(true);
    expect(
      isCosmosTxHash("0123456789abcdef".repeat(4))
    ).toBe(true);
  });

  it("rejects wrong lengths and non-hex", () => {
    expect(isCosmosTxHash("A".repeat(63))).toBe(false);
    expect(isCosmosTxHash("A".repeat(65))).toBe(false);
    expect(isCosmosTxHash("g".repeat(64))).toBe(false);
    expect(isCosmosTxHash(`${"A".repeat(32)}/${"A".repeat(31)}`)).toBe(false);
  });
});

describe("isBech32ish", () => {
  it("accepts real addresses across our chains", () => {
    expect(
      isBech32ish("atone144xwxcrlntp4wjadhrylzc6p3vdzscyex8kafh")
    ).toBe(true);
    expect(
      isBech32ish("atonevaloper144xwxcrlntp4wjadhrylzc6p3vdzscyey6a5r0")
    ).toBe(true);
    expect(isBech32ish("g1manfred47kzduec920z88wfr64ylksmdcedlf5")).toBe(true);
  });

  it("rejects traversal, uppercase and separators", () => {
    // Mixed case is invalid bech32 anyway, and allowing it would double the
    // charset a path could smuggle things through.
    expect(isBech32ish("atone1x/../staking/pool")).toBe(false);
    expect(isBech32ish("atone1x?limit=1")).toBe(false);
    expect(isBech32ish("Atone144xwxcrlntp4wjadhrylzc6p3vdzscyex8kafh")).toBe(false);
    expect(isBech32ish("short")).toBe(false);
    expect(isBech32ish("a".repeat(91))).toBe(false);
  });
});
