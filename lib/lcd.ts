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
}

const DEFAULT_TIMEOUT_MS = 5000;

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
  return fetchFrom<T>(chain.lcdEndpoints, requestPath, opts, chain.chainId);
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
  label = "chain"
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, next, cache, searchParams } = opts;

  let lastError: unknown;

  for (const endpoint of endpoints) {
    const url = buildUrl(endpoint, requestPath, searchParams);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        cache,
        next,
        headers: { accept: "application/json" },
      });

      if (!res.ok) {
        lastError = new LcdError(`LCD ${endpoint} responded ${res.status} for ${requestPath}`);
        continue;
      }

      return (await res.json()) as T;
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
