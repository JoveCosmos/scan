import { expect, test } from "vitest";
import { tokenHref } from "@/lib/gno-tokens";

test("a token's page is its realm without gno.land/, then its symbol", () => {
  expect(tokenHref("gnoland-1", { realm: "gno.land/r/gnoswap/gns", symbol: "GNS" })).toBe("/gnoland-1/tokens/r/gnoswap/gns/GNS");
  expect(tokenHref("gnoland-1", { realm: "gno.land/r/x/y", symbol: "a b" })).toBe("/gnoland-1/tokens/r/x/y/a%20b");
});
