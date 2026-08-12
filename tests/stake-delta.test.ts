import { describe, expect, it } from "vitest";
import { compare } from "@/lib/stake-delta";
import { isSnapshotDue } from "../indexer/src/stake";

/**
 * The arithmetic behind the 24h column, and the rule that decides when a
 * snapshot is taken. Both are pure, so both are worth pinning here rather than
 * discovering against a live chain.
 */

const now = (over: Record<string, string>) =>
  Object.entries(over).map(([operator, tokens]) => ({
    operatorAddress: operator,
    tokens,
  }));

describe("compare", () => {
  it("reports growth and shrinkage against the baseline", () => {
    const out = compare(now({ a: "1500", b: "800" }), new Map([["a", "1000"], ["b", "1000"]]));
    expect(out.get("a")?.change).toBe(BigInt(500));
    expect(out.get("b")?.change).toBe(BigInt(-200));
  });

  it("keeps full precision on stakes beyond a double", () => {
    // A large validator's balance in base denom exceeds Number.MAX_SAFE_INTEGER,
    // so this is BigInt end to end. Through a double, this difference vanishes.
    const out = compare(
      now({ a: "9007199254740993001" }),
      new Map([["a", "9007199254740993000"]])
    );
    expect(out.get("a")?.change).toBe(BigInt(1));
  });

  it("skips a validator with no baseline rather than showing all of its stake", () => {
    // Newly bonded since the baseline. "+100%" would be an artefact of when we
    // started looking, not something that happened.
    const out = compare(now({ newcomer: "5000" }), new Map([["other", "1000"]]));
    expect(out.has("newcomer")).toBe(false);
  });

  it("gives a signed ratio", () => {
    const out = compare(now({ a: "1100" }), new Map([["a", "1000"]]));
    expect(out.get("a")?.ratio).toBeCloseTo(0.1, 6);

    const down = compare(now({ a: "900" }), new Map([["a", "1000"]]));
    expect(down.get("a")?.ratio).toBeCloseTo(-0.1, 6);
  });

  it("returns a null ratio when the baseline was zero", () => {
    // Dividing by it would be Infinity, which renders as nonsense.
    const out = compare(now({ a: "500" }), new Map([["a", "0"]]));
    expect(out.get("a")?.change).toBe(BigInt(500));
    expect(out.get("a")?.ratio).toBeNull();
  });
});

describe("isSnapshotDue", () => {
  const t = (iso: string) => new Date(iso);

  it("is due when nothing has ever been recorded", () => {
    expect(isSnapshotDue(null, t("2026-08-11T00:00:00Z"), 3_600_000)).toBe(true);
  });

  it("is not due before the interval has elapsed", () => {
    expect(
      isSnapshotDue(t("2026-08-11T00:00:00Z"), t("2026-08-11T00:59:00Z"), 3_600_000)
    ).toBe(false);
  });

  it("is due exactly on the interval", () => {
    expect(
      isSnapshotDue(t("2026-08-11T00:00:00Z"), t("2026-08-11T01:00:00Z"), 3_600_000)
    ).toBe(true);
  });

  it("is due after a long gap, without trying to catch up", () => {
    // A missed day takes one snapshot now, not twenty-four backdated ones —
    // there is no way to recover stake as it was at a moment already past.
    expect(
      isSnapshotDue(t("2026-08-10T00:00:00Z"), t("2026-08-11T00:00:00Z"), 3_600_000)
    ).toBe(true);
  });
});
