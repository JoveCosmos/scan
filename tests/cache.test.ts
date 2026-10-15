import { describe, it, expect, beforeEach, vi } from "vitest";
import { cached, cacheSize, clearCache } from "@/lib/cache";

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

describe("cached, stale-while-revalidate", () => {
  it("returns the stale value at once and refreshes in the background", async () => {
    let n = 0;
    const load = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return `v${++n}`;
    };
    expect(await cached("swr", 10, load, { staleMs: 1000 })).toBe("v1");
    await new Promise((r) => setTimeout(r, 20));

    // Past the TTL, inside the stale window: no waiting on the loader.
    const started = Date.now();
    expect(await cached("swr", 10, load, { staleMs: 1000 })).toBe("v1");
    expect(Date.now() - started).toBeLessThan(20);

    await new Promise((r) => setTimeout(r, 50));
    expect(await cached("swr", 10, load, { staleMs: 1000 })).toBe("v2");
  });

  it("blocks once the value is older than the stale window", async () => {
    let n = 0;
    const load = async () => `v${++n}`;
    expect(await cached("swr2", 5, load, { staleMs: 10 })).toBe("v1");
    await new Promise((r) => setTimeout(r, 25));
    expect(await cached("swr2", 5, load, { staleMs: 10 })).toBe("v2");
  });
});

describe("cached bounds", () => {
  it("drops expired entries within a minute, however few there are", async () => {
    // The leak of 2026-10-05: below 4,000 keys nothing expired was ever dropped.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      for (let i = 0; i < 50; i++) await cached(`old:${i}`, 1000, async () => i);
      expect(cacheSize()).toBe(50);
      vi.setSystemTime(61_000);
      await cached("new", 1000, async () => "x");
      expect(cacheSize()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never holds more than its cap, dropping the least recently used first", async () => {
    for (let i = 0; i < 5100; i++) await cached(`k:${i}`, 3_600_000, async () => i);
    expect(cacheSize()).toBe(5000);
    // The newest survive; the first written were evicted and reload.
    const load = vi.fn(async () => "again");
    expect(await cached("k:5099", 3_600_000, load)).toBe(5099);
    expect(await cached("k:0", 3_600_000, load)).toBe("again");
  });

  it("evicts the least recently used: a read keeps an entry", async () => {
    await cached("hot", 3_600_000, async () => "hot");
    for (let i = 0; i < 5100; i++) {
      await cached(`k:${i}`, 3_600_000, async () => i);
      // Read on every page, like gno.land's package list.
      if (i % 100 === 0) await cached("hot", 3_600_000, async () => "reloaded");
    }
    const load = vi.fn(async () => "reloaded");
    expect(await cached("hot", 3_600_000, load)).toBe("hot");
    expect(load).not.toHaveBeenCalled();
  });

  it("holds a group to its size, most recently read kept", async () => {
    const group = { name: "big", max: 2 };
    for (const k of ["a", "b", "c"]) await cached(`g:${k}`, 3_600_000, async () => k, { group });
    const reload = vi.fn(async () => "reloaded");
    expect(await cached("g:c", 3_600_000, reload, { group })).toBe("c");
    expect(await cached("g:b", 3_600_000, reload, { group })).toBe("b");
    expect(await cached("g:a", 3_600_000, reload, { group })).toBe("reloaded");
  });
});
