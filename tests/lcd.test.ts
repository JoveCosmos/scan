import { describe, it, expect } from "vitest";
import { orderEndpoints } from "@/lib/lcd";

const A = "https://a.public";
const B = "https://b.public";
const OURS = "https://ours.gatadao.com";

describe("orderEndpoints", () => {
  it("keeps configured order when nothing has answered yet", () => {
    expect(orderEndpoints([A, B], [OURS])).toEqual([A, B, OURS]);
  });

  it("promotes the endpoint that last answered", () => {
    expect(orderEndpoints([A, B], [OURS], B)).toEqual([B, A, OURS]);
  });

  // The point of the split: our validator answering once must not turn it into
  // the primary for every later request.
  it("never promotes a fallback, even if it is the preferred one", () => {
    expect(orderEndpoints([A, B], [OURS], OURS)).toEqual([A, B, OURS]);
  });

  it("puts fallbacks last with a single primary", () => {
    expect(orderEndpoints([A], [OURS])).toEqual([A, OURS]);
  });

  it("works with no fallbacks at all", () => {
    expect(orderEndpoints([A, B], [], B)).toEqual([B, A]);
  });
});
