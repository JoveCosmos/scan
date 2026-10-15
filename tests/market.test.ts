import { expect, test } from "vitest";
import { formatUsdPrice } from "@/lib/market";

test("prices to four significant figures under a dollar", () => {
  expect(formatUsdPrice(0.01432188)).toBe("$0.01432");
  expect(formatUsdPrice(0.086923)).toBe("$0.08692");
  expect(formatUsdPrice(1.3549)).toBe("$1.35");
});
