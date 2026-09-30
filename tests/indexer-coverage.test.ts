import { describe, expect, it } from "vitest";
import { covers, type Coverage } from "@/lib/indexer-db";

/**
 * The gate that decides whether an indexed answer may be used.
 *
 * It matters more than it looks: backfill descends over days, so for most of
 * that time the index holds a *slice* of history. Serving a proposal whose
 * voting period predates the slice would show a subset of its votes as though
 * that were the whole picture - worse than being slow, because a wrong number
 * looks like a fact. Every case below is one where we must refuse.
 */
const cover: Coverage = {
  lowest: 9_200_000,
  highest: 9_830_000,
  from: "2026-07-01T00:00:00Z",
  to: "2026-08-10T00:00:00Z",
};

describe("covers", () => {
  it("accepts a voting period well inside the indexed range", () => {
    expect(
      covers(cover, "2026-07-10T00:00:00Z", "2026-07-24T00:00:00Z")
    ).toBe(true);
  });

  it("refuses a period that starts before the index does", () => {
    // The votes cast before coverage began simply are not there.
    expect(
      covers(cover, "2026-06-01T00:00:00Z", "2026-07-15T00:00:00Z")
    ).toBe(false);
  });

  it("refuses a period that ends after the index does", () => {
    expect(
      covers(cover, "2026-08-01T00:00:00Z", "2026-08-20T00:00:00Z")
    ).toBe(false);
  });

  it("refuses a period starting inside the first hour of coverage", () => {
    // A vote in the very first indexed block is only present by luck; the
    // margin stops a boundary case from passing as complete.
    expect(
      covers(cover, "2026-07-01T00:30:00Z", "2026-07-10T00:00:00Z")
    ).toBe(false);
  });

  it("accepts once past the margin", () => {
    expect(
      covers(cover, "2026-07-01T01:30:00Z", "2026-07-10T00:00:00Z")
    ).toBe(true);
  });

  it("refuses when there is no coverage at all", () => {
    expect(covers(null, "2026-07-10T00:00:00Z", "2026-07-24T00:00:00Z")).toBe(
      false
    );
  });

  it("refuses when the proposal has no voting window", () => {
    // A deposit-period proposal has no dates yet; absent must not mean "sure".
    expect(covers(cover, null, null)).toBe(false);
    expect(covers(cover, "2026-07-10T00:00:00Z", null)).toBe(false);
  });

  it("refuses unparseable dates rather than guessing", () => {
    expect(covers(cover, "not-a-date", "2026-07-24T00:00:00Z")).toBe(false);
  });
});
