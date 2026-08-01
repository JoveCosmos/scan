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
}

const CACHE_KEY = Symbol.for("gata.ttlCache");

const store = globalThis as typeof globalThis & {
  [CACHE_KEY]?: Map<string, Entry<unknown>>;
};

const cache: Map<string, Entry<unknown>> = (store[CACHE_KEY] ??= new Map());

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
  load: () => Promise<T>
): Promise<T> {
  const entry = cache.get(key) as Entry<T> | undefined;
  const now = Date.now();

  if (entry?.value !== undefined && now - entry.at < ttlMs) return entry.value;
  if (entry?.inflight) return entry.inflight;

  const inflight = load()
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((err) => {
      const prev = cache.get(key) as Entry<T> | undefined;
      if (prev?.value !== undefined) {
        // Keep serving the last good value; drop only the in-flight marker.
        cache.set(key, { at: prev.at, value: prev.value });
        return prev.value;
      }
      cache.delete(key);
      throw err;
    });

  cache.set(key, { at: entry?.at ?? 0, value: entry?.value, inflight });
  return inflight;
}

/** Test seam. */
export function clearCache(): void {
  cache.clear();
}
