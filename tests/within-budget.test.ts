import { describe, expect, it } from "vitest";
import { withinBudget } from "@/lib/cache";

describe("withinBudget", () => {
  it("returns the value when it arrives in time", async () => {
    expect(await withinBudget(Promise.resolve(7), 50, null)).toBe(7);
  });
  it("returns the fallback when the read runs late, and the read still completes", async () => {
    let done = false;
    const slow = new Promise<number>((r) => setTimeout(() => { done = true; r(1); }, 80));
    expect(await withinBudget(slow, 10, "late")).toBe("late");
    await slow;
    expect(done).toBe(true);
  });
  it("returns the fallback when the read fails", async () => {
    expect(await withinBudget(Promise.reject(new Error("x")), 50, 0)).toBe(0);
  });
});
