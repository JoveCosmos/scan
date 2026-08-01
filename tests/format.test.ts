import { describe, it, expect, vi, afterEach } from "vitest";
import { timeAgo, truncateMiddle, decodeParam } from "@/lib/format";
import { formatToken } from "@/lib/overview";
import { parseCoinString } from "@/lib/accounts";
import { symbolFor } from "@/lib/chains";
import type { ChainConfig } from "@/lib/chains";

afterEach(() => vi.useRealTimers());

describe("timeAgo", () => {
  it("handles null and unparseable input rather than showing NaN", () => {
    expect(timeAgo(null)).toBe("—");
    expect(timeAgo("not a date")).toBe("—");
  });

  it("scales through seconds, minutes, hours and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    expect(timeAgo("2026-01-01T23:59:55Z")).toBe("5s ago");
    expect(timeAgo("2026-01-01T23:30:00Z")).toBe("30m ago");
    expect(timeAgo("2026-01-01T20:00:00Z")).toBe("4h ago");
    expect(timeAgo("2025-12-30T00:00:00Z")).toBe("3d ago");
  });

  it("does not render a future timestamp as a negative age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    // Nodes can be a moment ahead of the browser clock.
    expect(timeAgo("2026-01-01T00:00:02Z")).toBe("just now");
  });
});

describe("truncateMiddle", () => {
  it("leaves short values alone", () => {
    expect(truncateMiddle("abc", 10, 6)).toBe("abc");
  });

  it("keeps both ends, which are the identifying parts", () => {
    const out = truncateMiddle("cosmosvaloper1qphf0ferqcch0jca9hlqfm3x0eds3dpkcvpafp", 10, 6);
    expect(out.startsWith("cosmosvalo")).toBe(true);
    expect(out.endsWith("cvpafp")).toBe(true);
    expect(out).toContain("…");
  });
});

describe("decodeParam", () => {
  it("decodes gno base64 hashes that arrive percent-encoded", () => {
    expect(decodeParam("X8I8dLTj3DV7m2%2BQGNik8swoN7KGRaOba%2BfQ7LRn86A%3D")).toBe(
      "X8I8dLTj3DV7m2+QGNik8swoN7KGRaOba+fQ7LRn86A="
    );
  });

  it("is a no-op for cosmos hex hashes", () => {
    const hex = "1AF826605DEA2B20EA87BE0CFEF582F22B92021906C1D4653FCB0F506C31D7BE";
    expect(decodeParam(hex)).toBe(hex);
  });

  it("returns malformed input untouched instead of throwing", () => {
    expect(decodeParam("%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("formatToken", () => {
  it("returns an em dash for null rather than NaN", () => {
    expect(formatToken(null, 6)).toBe("—");
  });

  it("converts by exponent and abbreviates by magnitude", () => {
    expect(formatToken("1000000", 6, 2)).toBe("1.00");
    expect(formatToken("1500000000", 6, 2)).toBe("1.50K");
    expect(formatToken("2500000000000", 6, 2)).toBe("2.50M");
  });
});

describe("parseCoinString", () => {
  it("parses the gno coin-string form", () => {
    expect(parseCoinString("999999997125000000ugnot")).toEqual([
      { amount: "999999997125000000", denom: "ugnot" },
    ]);
  });

  it("parses comma-separated coins", () => {
    expect(parseCoinString("100uatom,200ugnot")).toHaveLength(2);
  });

  it("ignores empty and malformed input", () => {
    expect(parseCoinString("")).toEqual([]);
    expect(parseCoinString("garbage")).toEqual([]);
  });
});

describe("symbolFor", () => {
  const chain = (denom: string) => ({ denom }) as ChainConfig;

  it("derives a ticker from the base denom", () => {
    expect(symbolFor(chain("uatom"))).toBe("ATOM");
    expect(symbolFor(chain("ugnot"))).toBe("GNOT");
    expect(symbolFor(chain("uatone"))).toBe("ATONE");
  });
});
