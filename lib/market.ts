import { cached } from "@/lib/cache";

/**
 * Price and market cap, from CoinGecko.
 *
 * The only data here that does not come from a chain node. It is therefore the
 * only thing that can be wrong in a way the chain cannot correct, so it is
 * clearly attributed in the UI and always optional: no key, no price, no
 * market figures — the rest of the page is unaffected.
 *
 * Cached for five minutes. The free endpoint is rate limited per IP, and every
 * viewer of every chain page would otherwise hit it.
 */

export interface MarketData {
  usd: number;
  marketCapUsd: number | null;
  change24h: number | null;
}

interface CoinGeckoResponse {
  [id: string]: {
    usd?: number;
    usd_market_cap?: number;
    usd_24h_change?: number;
  };
}

/** Market data for one CoinGecko id, or null when there is none to fetch. */
export async function getMarketDataById(
  id: string | undefined
): Promise<MarketData | null> {
  if (!id) return null;

  // Throws inside the cache callback rather than returning null, so a failure
  // is not cached. cached() only treats a rejection as a failure — a returned
  // null looks like a perfectly good value and would blank the price for the
  // full five minutes after one transient blip. On failure it keeps serving the
  // last good price instead.
  try {
    return await cached(`market:${id}`, 300_000, async () => {
      const url = new URL("https://api.coingecko.com/api/v3/simple/price");
      url.searchParams.set("ids", id);
      url.searchParams.set("vs_currencies", "usd");
      url.searchParams.set("include_market_cap", "true");
      url.searchParams.set("include_24hr_change", "true");

      const res = await fetch(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`coingecko responded ${res.status}`);

      const json = (await res.json()) as CoinGeckoResponse;
      const entry = json[id];
      if (!entry || typeof entry.usd !== "number") {
        throw new Error(`coingecko returned no price for ${id}`);
      }

      return {
        usd: entry.usd,
        marketCapUsd: entry.usd_market_cap ?? null,
        change24h: entry.usd_24h_change ?? null,
      };
    });
  } catch {
    return null;
  }
}

/** "$1.35", or "$0.146510" when a cent-scale price would round to nothing. */
export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** "$705.4M" — market caps are read at a glance, not to the dollar. */
export function formatUsdCompact(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
