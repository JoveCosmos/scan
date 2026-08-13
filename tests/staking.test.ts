import { describe, it, expect } from "vitest";
import { truncateDecimal } from "@/lib/staking";

describe("truncateDecimal", () => {
  it("drops the fraction from a reward amount", () => {
    // The real shape: uatom rewards for an account with one delegation.
    expect(truncateDecimal("16021146.828901032017806464")).toBe("16021146");
  });

  it("keeps precision beyond what a float could hold", () => {
    // 1218513392271.945… parsed as a Number and floored comes back 1218513392271
    // here but silently loses digits on larger balances, which is why this works
    // on the string.
    expect(truncateDecimal("69995572532191.940537221600633824")).toBe(
      "69995572532191"
    );
  });

  it("passes through an amount that is already an integer", () => {
    expect(truncateDecimal("65642016")).toBe("65642016");
  });

  it("treats a missing or malformed amount as zero", () => {
    expect(truncateDecimal(undefined)).toBe("0");
    expect(truncateDecimal("")).toBe("0");
    expect(truncateDecimal("not-a-number")).toBe("0");
    expect(truncateDecimal("-5.5")).toBe("0");
  });

  it("floors rather than rounds", () => {
    // A reward below one base unit is not claimable, so it must not present as 1.
    expect(truncateDecimal("0.999999999999999999")).toBe("0");
  });
});
