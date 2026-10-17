import type { ChainConfig } from "@/lib/chains";
import { getAllChains } from "@/lib/chains";
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

interface DenomTraceResponse {
  denom_trace?: { path?: string; base_denom?: string };
}

/** Bases whose decimals no prefix gives away. */
const KNOWN_EXPONENTS: Record<string, number> = { inj: 18, wei: 18 };

/**
 * "uosmo" → "OSMO", "stuatom" → "stATOM". Contract and factory denoms keep
 * their origin visible: a factory token named "uatom" must never pass for ATOM.
 */
export function symbolForBase(base: string): string {
  if (base.startsWith("cw20:")) return `CW20 ${base.slice(-6)}`;
  if (base.startsWith("factory/")) {
    const tail = base.split("/").pop() ?? base;
    return `factory/${tail.slice(0, 16)}`;
  }
  // Terra Classic's dollar is "uusd"; "USD" would read as an actual dollar.
  if (base === "uusd") return "USTC";
  // Liquid-staking derivatives: st + micro/atto prefix + base, or st + a
  // base with no prefix at all (stinj).
  if (/^st[ua][a-z]{2,}$/.test(base) && base !== "stake") {
    return `st${base.slice(3).toUpperCase()}`;
  }
  if (base.startsWith("st") && KNOWN_EXPONENTS[base.slice(2)] !== undefined) {
    return `st${base.slice(2).toUpperCase()}`;
  }
  if (/^u[a-z]{2,}$/.test(base)) return base.slice(1).toUpperCase();
  // Atto denoms, including upper-case ones such as Haqq's "aISLM".
  if (/^a([a-z]{2,}|[A-Z]{2,})$/.test(base)) return base.slice(1).toUpperCase();
  return base.slice(0, 12).toUpperCase();
}

/**
 * Decimals for a base denom when no metadata says so: micro is 6, atto is 18,
 * and a liquid-staking wrapper inherits its underlying token's. Null when the
 * shape gives nothing away - the amount is then shown in base units rather
 * than scaled by a guessed power of ten.
 */
export function inferExponent(base: string): number | null {
  if (KNOWN_EXPONENTS[base] !== undefined) return KNOWN_EXPONENTS[base];
  // A factory token carried over IBC: its sub-denom follows the same convention.
  if (base.startsWith("factory/")) return inferExponent(base.split("/").pop() ?? "");
  const inner = base.startsWith("st") && base !== "stake" ? base.slice(2) : base;
  if (KNOWN_EXPONENTS[inner] !== undefined) return KNOWN_EXPONENTS[inner];
  if (/^u[a-z]{2,}$/.test(inner)) return 6;
  if (/^a([a-z]{2,}|[A-Z]{2,})$/.test(inner)) return 18;
  return null;
}

/**
 * Resolve an `ibc/<HASH>` denom to what it actually is.
 *
 * Two endpoints, because chains sit on different IBC versions: current ones
 * answer `denoms/{hash}` and 501 on `denom_traces`; Osmosis is the other way
 * round, which left every Osmosis IBC balance as "IBC 27394F…".
 *
 * Traces are immutable, so this is cached for an hour, "unknown" included.
 */
async function resolveIbcDenom(
  chain: ChainConfig,
  denom: string
): Promise<DenomTrace | null> {
  if (!denom.startsWith("ibc/")) return null;
  const hash = denom.slice(4);

  // Versioned key: the previous shape cached a null for every Osmosis denom.
  return cached(`ibc2:${chain.chainId}:${hash}`, 3_600_000, async () => {
    try {
      const res = await fetchLcd<DenomResponse>(
        chain,
        `/ibc/apps/transfer/v1/denoms/${hash}`,
        { cache: "no-store", timeoutMs: 6000, deadlineMs: 8000 }
      );
      const base = res.denom?.base;
      if (base) {
        return {
          base,
          channels: (res.denom?.trace ?? [])
            .map((hop) => hop.channel_id)
            .filter((c): c is string => !!c),
          symbol: symbolForBase(base),
        };
      }
    } catch {
      // Fall through to the older endpoint.
    }
    try {
      const res = await fetchLcd<DenomTraceResponse>(
        chain,
        `/ibc/apps/transfer/v1/denom_traces/${hash}`,
        { cache: "no-store", timeoutMs: 6000, deadlineMs: 8000 }
      );
      const base = res.denom_trace?.base_denom;
      if (!base) return null;
      const path = res.denom_trace?.path ?? "";
      const channels = path
        .split("/")
        .filter((part) => part.startsWith("channel-"));
      return { base, channels, symbol: symbolForBase(base) };
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

/** What an asset is, for display: its ticker and how to scale it. */
export interface AssetInfo {
  denom: string;
  symbol: string;
  /** Decimal places; null when unknown, in which case show base units. */
  exponent: number | null;
  kind: "native" | "ibc" | "factory" | "cw20" | "other";
  /** For IBC: the home denom and the channels it came through. */
  base: string | null;
  channels: string[];
}

interface MetadataResponse {
  metadata?: {
    display?: string;
    symbol?: string;
    denom_units?: { denom?: string; exponent?: number }[];
  };
}

/**
 * Decimals and ticker from the chain's own bank metadata, where the issuer set
 * any. Factory tokens usually carry it; IBC denoms usually carry only a
 * zero-exponent unit, which says nothing, so that counts as absent.
 */
async function bankMetadata(
  chain: ChainConfig,
  denom: string
): Promise<{ symbol: string | null; exponent: number } | null> {
  return cached(`denom-meta:${chain.chainId}:${denom}`, 6 * 3_600_000, async () => {
    try {
      const res = await fetchLcd<MetadataResponse>(
        chain,
        "/cosmos/bank/v1beta1/denoms_metadata_by_query_string",
        { cache: "no-store", timeoutMs: 5000, deadlineMs: 7000, searchParams: { denom } }
      );
      const units = res.metadata?.denom_units ?? [];
      const display = res.metadata?.display;
      const unit =
        units.find((u) => u.denom === display && (u.exponent ?? 0) > 0) ??
        [...units].sort((a, b) => (b.exponent ?? 0) - (a.exponent ?? 0))[0];
      const exponent = unit?.exponent ?? 0;
      if (exponent <= 0) return null;
      const candidate = res.metadata?.symbol || unit?.denom || display || null;
      const symbol = candidate && !candidate.includes("/") && candidate.length <= 16 ? candidate : null;
      return { symbol, exponent };
    } catch {
      return null;
    }
  });
}

/** Every denom one of our chains stakes or pays fees in, with its decimals. */
function homeDenoms(): Map<string, { symbol: string; exponent: number }> {
  const out = new Map<string, { symbol: string; exponent: number }>();
  for (const c of getAllChains()) {
    if (!out.has(c.denom)) out.set(c.denom, { symbol: symbolForBase(c.denom), exponent: c.exponent });
    if (c.feeDenom && !out.has(c.feeDenom)) {
      out.set(c.feeDenom, { symbol: symbolForBase(c.feeDenom), exponent: c.exponent });
    }
  }
  return out;
}

/**
 * Ticker and decimals for every denom in a balance list. Natives come from
 * config; IBC denoms through their trace, then whatever chain of ours issues
 * the base, then the base's shape; factory tokens from bank metadata. Anything
 * still unknown keeps a null exponent and is shown in base units, never scaled
 * by a guess.
 */
export async function resolveAssets(
  chain: ChainConfig,
  denoms: string[],
  natives: { denom: string; symbol: string; exponent: number }[]
): Promise<Map<string, AssetInfo>> {
  const nativeMap = new Map(natives.map((n) => [n.denom, n]));
  const home = homeDenoms();
  const unique = [...new Set(denoms)];

  const entries = await Promise.all(
    unique.map(async (denom): Promise<[string, AssetInfo]> => {
      const native = nativeMap.get(denom);
      if (native) {
        return [denom, { denom, symbol: native.symbol, exponent: native.exponent, kind: "native", base: null, channels: [] }];
      }

      if (denom.startsWith("ibc/")) {
        const trace = await resolveIbcDenom(chain, denom);
        if (!trace) {
          return [denom, { denom, symbol: `IBC ${denom.slice(4, 10)}…`, exponent: null, kind: "ibc", base: null, channels: [] }];
        }
        const known = home.get(trace.base);
        const exponent = known?.exponent ?? inferExponent(trace.base);
        return [
          denom,
          {
            denom,
            symbol: known?.symbol ?? symbolForBase(trace.base),
            exponent,
            kind: "ibc",
            base: trace.base,
            channels: trace.channels,
          },
        ];
      }

      if (denom.startsWith("factory/")) {
        const meta = await bankMetadata(chain, denom);
        return [
          denom,
          {
            denom,
            // The issuer picks its own ticker, and "STARS" or "ATOM" is free
            // to take: the origin stays in the name so it cannot pass as native.
            symbol: meta?.symbol ? `factory/${meta.symbol}` : symbolForBase(denom),
            exponent: meta?.exponent ?? null,
            kind: "factory",
            base: null,
            channels: [],
          },
        ];
      }

      if (denom.startsWith("cw20:")) {
        return [denom, { denom, symbol: symbolForBase(denom), exponent: null, kind: "cw20", base: null, channels: [] }];
      }

      const meta = await bankMetadata(chain, denom);
      return [
        denom,
        {
          denom,
          symbol: meta?.symbol ?? symbolForBase(denom),
          exponent: meta?.exponent ?? inferExponent(denom),
          kind: "other",
          base: null,
          channels: [],
        },
      ];
    })
  );

  return new Map(entries);
}
