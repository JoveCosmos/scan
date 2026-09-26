import { describe, expect, it } from "vitest";
import { base64ToHex, formatDate, formatDateTime, timeUntil } from "@/lib/format";

const now = Date.parse("2026-09-25T00:00:00Z");

describe("timeUntil", () => {
  it("counts down to a future moment instead of saying 'just now'", () => {
    expect(timeUntil("2026-09-30T00:00:00Z", now)).toBe("in 5d 0h");
    expect(timeUntil("2026-09-25T05:30:00Z", now)).toBe("in 5h 30m");
    expect(timeUntil("2026-09-25T00:10:00Z", now)).toBe("in 10m");
  });
  it("says ended for the past and null for junk", () => {
    expect(timeUntil("2026-09-24T00:00:00Z", now)).toBe("ended");
    expect(timeUntil("not a date", now)).toBeNull();
    expect(timeUntil(null, now)).toBeNull();
  });
});

describe("dates and hashes", () => {
  it("formats in UTC, the same on server and browser", () => {
    expect(formatDate("2026-09-30T23:20:17.999314823Z")).toBe("30 Sep 2026");
    expect(formatDateTime("2026-09-30T23:20:17Z")).toBe("30 Sep 2026, 23:20 UTC");
  });
  it("turns a base64 block hash into hex", () => {
    expect(base64ToHex("3u2RXQ==")).toBe("DEED915D");
    expect(base64ToHex("DEED915D")).toBe("DEED915D");
  });
});
