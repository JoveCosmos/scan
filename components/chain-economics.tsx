import type { ChainConfig } from "@/lib/chains";
import { symbolFor } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { Suspense } from "react";
import { getChainEconomics, getHolderCount } from "@/lib/params";
import { formatUsdCompact, type MarketData } from "@/lib/market";

/**
 * Price, yield and token distribution.
 *
 * Streamed separately because the holder count is a full scan of every account
 * holding the denom — 2.7s on Cosmos Hub, 25s on AtomOne, whose airdrop left it
 * with over three million holders. Nothing above this section depends on it.
 */
export async function ChainEconomics({
  chain,
  communityTax,
  minCommission,
  supply,
  market,
}: {
  chain: ChainConfig;
  communityTax: number | null;
  minCommission: number | null;
  /** Total supply in base denom, shown here and used for the pool's share. */
  supply: string | null;
  /** Fetched by the page for the price box; reused here for the pool's USD value. */
  market: MarketData | null;
}) {
  const economics = await getChainEconomics(
    chain,
    communityTax,
    minCommission
  ).catch(() => null);

  if (!economics && !supply) return null;
  const symbol = symbolFor(chain);

  return (
    <section className="mt-6">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">Tokenomics</h2>
      <div className="gata-panel">
        <dl>
          {supply ? (
            <Row
              label="Total supply"
              value={`${formatToken(supply, chain.exponent)} ${symbol}`}
            />
          ) : null}

          {economics?.stakingApr != null ? (
            <Row
              label="Staking APR"
              value={`${(economics.stakingApr * 100).toFixed(2)}%`}
              // The headline rate is before commission, which nobody actually
              // receives — so the achievable best case sits next to it.
              trailing={
                economics.stakingAprAfterMinCommission != null ? (
                  <span className="text-muted-foreground">
                    {(economics.stakingAprAfterMinCommission * 100).toFixed(2)}% at
                    the {((minCommission ?? 0) * 100).toFixed(0)}% minimum commission
                  </span>
                ) : (
                  <span className="text-muted-foreground">before commission</span>
                )
              }
            />
          ) : null}

          {economics?.communityPool ? (
            <Row
              label="Community pool"
              value={`${formatToken(economics.communityPool, chain.exponent)} ${symbol}`}
              trailing={
                <span className="text-muted-foreground">
                  {poolShare(economics.communityPool, supply)}
                  {market
                    ? ` · ${formatUsdCompact(
                        (Number(economics.communityPool) / 10 ** chain.exponent) *
                          market.usd
                      )}`
                    : ""}
                  {" · native denom only"}
                </span>
              }
            />
          ) : null}

          {/* Its own boundary: the holder scan takes 25s on AtomOne and must
              not hold back the rows above it. */}
          <Suspense fallback={<HolderRow symbol={symbol} value="counting…" />}>
            <HolderCount chain={chain} symbol={symbol} />
          </Suspense>
        </dl>
      </div>
    </section>
  );
}

/** The pool's share of total supply — how much of the token the chain itself holds. */
function poolShare(pool: string, supply: string | null): string {
  const p = Number(pool);
  const s = Number(supply);
  if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) return "";
  return `${((p / s) * 100).toFixed(2)}% of supply`;
}

async function HolderCount({
  chain,
  symbol,
}: {
  chain: ChainConfig;
  symbol: string;
}) {
  const holders = await getHolderCount(chain).catch(() => null);
  if (holders === null) return null;
  return <HolderRow symbol={symbol} value={holders.toLocaleString()} />;
}

function HolderRow({ symbol, value }: { symbol: string; value: string }) {
  return (
    <Row
      label={`${symbol} holders`}
      value={value}
      trailing={
        <span className="text-muted-foreground">
          addresses with a non-zero balance
        </span>
      }
    />
  );
}

function Row({
  label,
  value,
  trailing,
}: {
  label: string;
  value: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3 last:border-0 sm:grid-cols-[260px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm">{value}</span>
        {trailing ? <span className="text-xs">{trailing}</span> : null}
      </dd>
    </div>
  );
}
