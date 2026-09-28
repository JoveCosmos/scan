/**
 * Tiny TTL cache with in-flight de-duplication.
 *
 * Every viewer polls the head endpoint independently, so without this N open
 * tabs meant N upstream requests per interval against the same public node.
 * Concurrent callers now share one in-flight request and a short cached result,
 * which collapses that to one request per TTL regardless of viewer count.
 *
 * Kept on globalThis for the same reason as the valopers index: instrumentation
 * and route handlers are bundled separately and would otherwise hold different
 * module instances.
 */
interface Entry<T> {
  at: number;
  value?: T;
  inflight?: Promise<T>;
  /** How long this entry is worth keeping at all; past it the sweep drops it. */
  keepMs: number;
}

const CACHE_KEY = Symbol.for("gata.ttlCache");

const store = globalThis as typeof globalThis & {
  [CACHE_KEY]?: Map<string, Entry<unknown>>;
};

const cache: Map<string, Entry<unknown>> = (store[CACHE_KEY] ??= new Map());

/**
 * Keys include heights and addresses, so the map would otherwise grow for as
 * long as the process lives. Past this size, expired entries are dropped.
 */
const SWEEP_AT = 4000;

function sweep(now: number) {
  if (cache.size < SWEEP_AT) return;
  for (const [key, entry] of cache) {
    if (!entry.inflight && now - entry.at > entry.keepMs) cache.delete(key);
  }
}

export interface CacheOptions {
  /**
   * Stale-while-revalidate. A value older than the TTL but younger than this is
   * returned at once while a refresh runs in the background, so a slow upstream
   * read only ever blocks the very first request, never a later one.
   */
  staleMs?: number;
}

function load<T>(key: string, ttlMs: number, keepMs: number, loader: () => Promise<T>) {
  const entry = cache.get(key) as Entry<T> | undefined;
  const inflight = loader()
    .then((value) => {
      const now = Date.now();
      cache.set(key, { at: now, value, keepMs });
      sweep(now);
      return value;
    })
    .catch((err) => {
      const prev = cache.get(key) as Entry<T> | undefined;
      if (prev?.value !== undefined) {
        // Keep serving the last good value; drop only the in-flight marker.
        cache.set(key, { at: prev.at, value: prev.value, keepMs });
        return prev.value;
      }
      cache.delete(key);
      throw err;
    });

  cache.set(key, { at: entry?.at ?? 0, value: entry?.value, inflight, keepMs });
  return inflight;
}

/**
 * Returns a cached value when it is younger than ttlMs, joins an in-flight
 * request when one is running, and otherwise calls load().
 *
 * A failed load is never cached, but a previously good value is kept and served
 * rather than surfacing a transient upstream blip to the page.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options: CacheOptions = {}
): Promise<T> {
  const entry = cache.get(key) as Entry<T> | undefined;
  const now = Date.now();
  const staleMs = Math.max(options.staleMs ?? 0, ttlMs);
  const keepMs = Math.max(staleMs, ttlMs) * 2;

  if (entry?.value !== undefined) {
    const age = now - entry.at;
    if (age < ttlMs) return entry.value;
    if (age < staleMs) {
      if (!entry.inflight) void load(key, ttlMs, keepMs, loader).catch(() => {});
      return entry.value;
    }
  }
  if (entry?.inflight) return entry.inflight;

  return load(key, ttlMs, keepMs, loader);
}

/** Test seam. */
export function clearCache(): void {
  cache.clear();
}

/**
 * Wait for a read at most `ms`, then carry on without it. The read keeps
 * running, so a cached loader still fills its cache for the next view: a page
 * never waits on a slow, optional figure, and the figure appears once warm.
 */
export function withinBudget<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    promise.catch(() => fallback).finally(() => clearTimeout(timer)),
    late,
  ]);
}
