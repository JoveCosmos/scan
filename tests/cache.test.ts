import { describe, it, expect, beforeEach, vi } from "vitest";
import { cached, clearCache } from "@/lib/cache";

beforeEach(() => clearCache());

describe("cached", () => {
  it("calls the loader once for concurrent callers", async () => {
    const load = vi.fn(async () => "value");
    const [a, b, c] = await Promise.all([
      cached("k", 1000, load),
      cached("k", 1000, load),
      cached("k", 1000, load),
    ]);
    expect([a, b, c]).toEqual(["value", "value", "value"]);
    // This is the point of the cache: three viewers, one upstream request.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves from cache inside the TTL and reloads after it", async () => {
    let n = 0;
    const load = async () => `v${++n}`;

    expect(await cached("k", 50, load)).toBe("v1");
    expect(await cached("k", 50, load)).toBe("v1");

    await new Promise((r) => setTimeout(r, 60));
    expect(await cached("k", 50, load)).toBe("v2");
  });

  it("keeps separate entries per key", async () => {
    expect(await cached("a", 1000, async () => 1)).toBe(1);
    expect(await cached("b", 1000, async () => 2)).toBe(2);
  });

  it("propagates the error when there is no previous value", async () => {
    await expect(
      cached("k", 1000, async () => {
        throw new Error("upstream down");
      })
    ).rejects.toThrow("upstream down");
  });

  it("keeps serving the last good value when a refresh fails", async () => {
    expect(await cached("k", 10, async () => "good")).toBe("good");
    await new Promise((r) => setTimeout(r, 20));

    // A transient node failure must not surface as an error to the page.
    expect(
      await cached("k", 10, async () => {
        throw new Error("blip");
      })
    ).toBe("good");
  });

  it("does not cache a failure, so the next call retries", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("first fails");
      return "ok";
    };

    await expect(cached("k", 1000, flaky)).rejects.toThrow();
    expect(await cached("k", 1000, flaky)).toBe("ok");
  });
});
