import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";

export interface DenomTrace {
  /** The original denom on its home chain, e.g. "uosmo". */
  base: string;
  /** Channel it arrived through, nearest hop first. */
  channels: string[];
  /** Display ticker derived from the base, e.g. "OSMO". */
  symbol: string;
}

interface DenomResponse {
  denom?: {
    base?: string;
    trace?: { port_id?: string; channel_id?: string }[];
  };
}

/** "uosmo" -> "OSMO"; leaves non-micro and contract denoms recognisable. */
export function symbolForBase(base: string): string {
  if (base.startsWith("cw20:")) return "CW20";
  if (base.startsWith("factory/")) {
    const tail = base.split("/").pop() ?? base;
    return tail.slice(0, 12).toUpperCase();
  }
  if (/^u[a-z]{2,}$/.test(base)) return base.slice(1).toUpperCase();
  if (/^a[a-z]{2,}$/.test(base)) return base.slice(1).toUpperCase();
  return base.slice(0, 12).toUpperCase();
}

/**
 * Resolve an `ibc/<HASH>` denom to what it actually is.
 *
 * Note the endpoint: `denom_traces` returns 501 Not Implemented on every chain
 * here, while `denoms/{hash}` works — the older path is gone in current IBC.
 *
 * Traces are immutable, so this is cached for an hour. A 404 is a normal answer
 * (that hash is unknown on this chain) and is cached as "unknown" too, rather
 * than retried on every page view.
 */
export async function resolveIbcDenom(
  chain: ChainConfig,
  denom: string
): Promise<DenomTrace | null> {
  if (!denom.startsWith("ibc/")) return null;
  const hash = denom.slice(4);

  return cached(`ibc:${chain.chainId}:${hash}`, 3_600_000, async () => {
    try {
      const res = await fetchLcd<DenomResponse>(
        chain,
        `/ibc/apps/transfer/v1/denoms/${hash}`,
        { cache: "no-store", timeoutMs: 8000 }
      );
      const base = res.denom?.base;
      if (!base) return null;

      return {
        base,
        channels: (res.denom?.trace ?? [])
          .map((hop) => hop.channel_id)
          .filter((c): c is string => !!c),
        symbol: symbolForBase(base),
      };
    } catch {
      return null;
    }
  });
}

/** Resolve every IBC denom in a balance list, in parallel. */
export async function resolveIbcDenoms(
  chain: ChainConfig,
  denoms: string[]
): Promise<Map<string, DenomTrace>> {
  const ibcDenoms = [...new Set(denoms.filter((d) => d.startsWith("ibc/")))];
  const out = new Map<string, DenomTrace>();

  const traces = await Promise.all(
    ibcDenoms.map(async (denom) => [denom, await resolveIbcDenom(chain, denom)] as const)
  );

  for (const [denom, trace] of traces) {
    if (trace) out.set(denom, trace);
  }
  return out;
}
