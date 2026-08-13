import type { ChainConfig } from "@/lib/chains";

export class LcdError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LcdError";
  }
}

interface FetchLcdOptions {
  timeoutMs?: number;
  next?: NextFetchRequestConfig;
  cache?: RequestCache;
  searchParams?: Record<string, string | number | boolean | undefined>;
  /** Extra request headers — notably x-cosmos-block-height for state at a past
   *  height, which is how the 24h stake delta is measured. */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5000;

/*
 * Which endpoint answered last, per endpoint list. Endpoint health is sticky in
 * practice — a node that just failed is likely to fail again — so remembering
 * the winner avoids paying the timeout repeatedly. Held on globalThis because
 * route handlers and instrumentation are bundled separately.
 */
const HEALTH_KEY = Symbol.for("gata.endpointHealth");
const healthStore = globalThis as typeof globalThis & {
  [HEALTH_KEY]?: Map<string, string>;
};
const lastGood: Map<string, string> = (healthStore[HEALTH_KEY] ??= new Map());

/**
 * Primaries in health order, then fallbacks in the order given.
 *
 * A fallback is never promoted, however well it answers. These are our own
 * validator nodes: they exist so the scan keeps working when the public
 * endpoints do not, and stickiness would quietly turn one failover into
 * carrying the site's traffic indefinitely. Kept pure so the rule is testable
 * without a network.
 */
export function orderEndpoints(
  primaries: string[],
  fallbacks: string[] = [],
  preferred?: string
): string[] {
  // primaries.includes is the load-bearing part. Without it a preferred value
  // that is not a primary — a fallback — gets prepended, which both promotes it
  // and leaves it in the list twice.
  const promotable =
    preferred !== undefined &&
    primaries.length > 1 &&
    primaries[0] !== preferred &&
    primaries.includes(preferred);

  const ordered = promotable
    ? [preferred, ...primaries.filter((e) => e !== preferred)]
    : primaries;
  return [...ordered, ...fallbacks];
}

function buildUrl(
  base: string,
  requestPath: string,
  searchParams?: FetchLcdOptions["searchParams"]
): string {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(requestPath.replace(/^\//, ""), normalizedBase);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function fetchLcd<T>(
  chain: ChainConfig,
  requestPath: string,
  opts: FetchLcdOptions = {}
): Promise<T> {
  return fetchFrom<T>(
    chain.lcdEndpoints,
    requestPath,
    opts,
    chain.chainId,
    chain.fallbackLcdEndpoints
  );
}

/**
 * Endpoint-failover JSON fetch over an arbitrary base-URL list. Shared by the
 * Cosmos LCD client and the gno RPC/API clients, which have the same need for
 * timeouts and fallback but entirely different URL shapes.
 */
export async function fetchFrom<T>(
  endpoints: string[],
  requestPath: string,
  opts: FetchLcdOptions = {},
  label = "chain",
  /** Tried only once every primary has failed, and never remembered. */
  fallbacks: string[] = []
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, next, cache, searchParams, headers } = opts;

  let lastError: unknown;

  // Try whichever endpoint last answered first. Without this a dead primary
  // costs the full timeout on *every* request before the fallback is reached.
  const preferred = endpoints.length > 1 ? lastGood.get(endpoints.join("|")) : undefined;
  for (const endpoint of orderEndpoints(endpoints, fallbacks, preferred)) {
    const url = buildUrl(endpoint, requestPath, searchParams);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        cache,
        next,
        headers: { accept: "application/json", ...headers },
      });

      if (!res.ok) {
        lastError = new LcdError(`LCD ${endpoint} responded ${res.status} for ${requestPath}`);
        continue;
      }

      const body = (await res.json()) as T;
      // Only primaries are remembered — see orderEndpoints.
      if (endpoints.length > 1 && endpoints.includes(endpoint)) {
        lastGood.set(endpoints.join("|"), endpoint);
      }
      return body;
    } catch (err) {
      lastError = err instanceof Error ? err : new LcdError(String(err));
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new LcdError(
    `All endpoints failed for ${label}, path ${requestPath}`,
    lastError
  );
}
