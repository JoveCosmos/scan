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
const GROUPS_KEY = Symbol.for("gata.ttlCacheGroups");

const store = globalThis as typeof globalThis & {
  [CACHE_KEY]?: Map<string, Entry<unknown>>;
  [GROUPS_KEY]?: Map<string, string[]>;
};

const cache: Map<string, Entry<unknown>> = (store[CACHE_KEY] ??= new Map());
/** Keys of each capped group, oldest first. */
const groups: Map<string, string[]> = (store[GROUPS_KEY] ??= new Map());

/**
 * Keys include heights, hashes and addresses, so without a bound the map grows
 * for as long as the process lives. Production reached 7.2 GB in 27 hours
 * (2026-10-05): the old sweep ran only once 4,000 keys had piled up, and below
 * that no expired entry was ever dropped, so every validator page a crawler
 * opened left its whole delegator ranking behind.
 *
 * Now expired entries go at least once a minute, and past MAX_ENTRIES the
 * least recently used go too, expired or not: a read moves its entry to the
 * back, so a list every page reads (gno.land's packages) outlives a crawl of
 * one-off block pages.
 */
const SWEEP_EVERY_MS = 60_000;
const MAX_ENTRIES = 5000;
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep >= SWEEP_EVERY_MS || cache.size > MAX_ENTRIES) {
    lastSweep = now;
    for (const [key, entry] of cache) {
      if (!entry.inflight && now - entry.at > entry.keepMs) cache.delete(key);
    }
  }
  // Map order is use order (see put() and the read in cached()), so the first
  // keys are the least recently used.
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_ENTRIES) break;
    if (!entry.inflight) cache.delete(key);
  }
}

/** Writes an entry as the newest, so the cap evicts by age of the last write. */
function put(key: string, entry: Entry<unknown>) {
  cache.delete(key);
  cache.set(key, entry);
}

/** Holds a group to its size: past `max`, its oldest key is dropped. */
function admit(key: string, group: { name: string; max: number }) {
  const keys = groups.get(group.name) ?? [];
  const at = keys.indexOf(key);
  if (at !== -1) keys.splice(at, 1);
  keys.push(key);
  while (keys.length > group.max) {
    const old = keys.shift()!;
    if (!cache.get(old)?.inflight) cache.delete(old);
  }
  groups.set(group.name, keys);
}

export interface CacheOptions {
  /**
   * Stale-while-revalidate. A value older than the TTL but younger than this is
   * returned at once while a refresh runs in the background, so a slow upstream
   * read only ever blocks the very first request, never a later one.
   */
  staleMs?: number;
  /**
   * At most `max` entries of this group at once, oldest dropped first. For
   * values large enough that the global cap alone would still hold too much
   * (a validator's whole delegator ranking).
   */
  group?: { name: string; max: number };
}

function load<T>(
  key: string,
  ttlMs: number,
  keepMs: number,
  loader: () => Promise<T>,
  group?: CacheOptions["group"]
) {
  const entry = cache.get(key) as Entry<T> | undefined;
  const inflight = loader()
    .then((value) => {
      const now = Date.now();
      put(key, { at: now, value, keepMs });
      if (group) admit(key, group);
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
 * A validator page's figures from the index (blocks proposed, commission,
 * power, events, votes, signing): served up to ten minutes while they
 * refresh, with room for every AtomOne validator and some inactive ones. The
 * index answers each in milliseconds since migration 013.
 */
export function VALIDATOR_HISTORY_CACHE(group: string): CacheOptions {
  return { staleMs: 10 * 60_000, group: { name: group, max: 160 } };
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
    // A read keeps the entry: to the back of the eviction order.
    cache.delete(key);
    cache.set(key, entry);
    if (age < ttlMs) return entry.value;
    if (age < staleMs) {
      if (!entry.inflight) void load(key, ttlMs, keepMs, loader, options.group).catch(() => {});
      return entry.value;
    }
  }
  if (entry?.inflight) return entry.inflight;

  return load(key, ttlMs, keepMs, loader, options.group);
}

/** Test seam. */
export function clearCache(): void {
  cache.clear();
  groups.clear();
  lastSweep = 0;
}

/** Test seam: how many entries the cache holds. */
export function cacheSize(): number {
  return cache.size;
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
