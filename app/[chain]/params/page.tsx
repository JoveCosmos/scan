import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getAllChains,
  getChain,
  accentFor,
  symbolFor,
  symbolForDenom,
  logoFor,
  chainDenoms,
} from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { getChainParams, getChainEconomics, getAprRange, humanDuration } from "@/lib/params";
import { getSupplyOf } from "@/lib/params";
import { getLatestRelease } from "@/lib/github";
import { getMarketDataById, formatUsd, formatUsdCompact } from "@/lib/market";
import { recentJailings } from "@/lib/indexer-validator";
import { consensusIdsFromPubkey } from "@/lib/uptime";
import Image from "next/image";
import { PageFrame } from "@/components/page-frame";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { BlocksTable } from "@/components/blocks-table";
import { TxsTable } from "@/components/txs-table";
import { denomsForTxs } from "@/lib/txs";
import { nameProposers } from "@/lib/blocks";
import { withProposerLogos } from "@/lib/validator-logos";
import { policyFor } from "@/lib/tiers";
import { BrickBoard, type BrickSpec, type DetailRow } from "@/components/brick-board";

export const dynamic = "force-dynamic";
export const dynamicParams = true;

export function generateStaticParams() {
  return getAllChains().map((chain) => ({ chain: chain.chainId }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  return { title: getChain(chainId)?.prettyName ?? "Chain" };
}

const pct = (value: number | null | undefined, decimals = 2) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(decimals)}%`;

const num = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString();

/** Inverts "min signed per window" into the miss budget it actually implies. */
function missableBlocks(window: number | null, minSigned: number | null): string {
  if (window === null || minSigned === null) return "—";
  return `${Math.floor(window * (1 - minSigned)).toLocaleString()} of ${window.toLocaleString()}`;
}

/** Drops rows whose value is a dash, so a popup never lists absent facts. */
const kept = (rows: DetailRow[]) => rows.filter((r) => r.value !== "—" && r.value !== "");

/**
 * The overview, laid out in bricks.
 *
 * It used to be eight stacked sections of label/value rows — around forty of
 * them, most of which nobody reads on any given visit, and all of which had to
 * be scrolled past to reach the next heading. The same forty facts are here.
 * What changed is that a section is now one brick showing the figure worth
 * knowing, with the rest a click away, which is what lets the page end at the
 * bottom of the screen.
 *
 * Everything is resolved here and handed over as data. Bricks carry no chain
 * knowledge, so the same board renders this page and the Infra tab.
 *
 * The holder count is deliberately absent: it is a full scan of every account
 * with a balance and takes ~25s on AtomOne. It was streamed in behind Suspense
 * before, which is invisible on a scrolling page and impossible on a board that
 * has to be laid out at once. A fast page is worth more than that one number.
 */
export default async function ChainOverviewPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const adapter = getAdapter(chain);
  const caps = adapter.capabilities;
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);
  const feeSymbol = chain.feeDenom ? symbolForDenom(chain.feeDenom) : "";
  const base = `/${chain.chainId}`;

  const policy = policyFor(chain);
  const [overview, chainParams, release, feeSupply, market, feeMarket, validators, jailings, recentBlocks, recentTxs] =
    await Promise.all([
      adapter.getOverview(),
      caps.staking ? getChainParams(chain) : null,
      getLatestRelease(chain.repo).catch(() => null),
      chain.feeDenom ? getSupplyOf(chain, chain.feeDenom).catch(() => null) : null,
      getMarketDataById(chain.coingeckoId).catch(() => null),
      getMarketDataById(chain.feeCoingeckoId).catch(() => null),
      // Cached set, shared with the validators tab: feeds Nakamoto and names.
      adapter.getValidators().catch(() => []),
      caps.staking ? recentJailings(chain.chainId).catch(() => null) : null,
      // The dashboard cards: both feeds are shared caches with their tabs.
      adapter.getRecentBlocks().catch(() => []),
      policy.txs ? adapter.getRecentTxs().catch(() => null) : null,
    ]);

  // Three more LCD reads, and the only ones here that are not either config or
  // already on the overview. Bounded and independently catchable.
  const economics = caps.staking
    ? await getChainEconomics(
        chain,
        chainParams?.distribution?.communityTax ?? null,
        chainParams?.staking?.minCommissionRate ?? null
      ).catch(() => null)
    : null;

  // AtomOne-style APR range (null on chains with plain proportional rewards),
  // and the active set's average signing uptime.
  const [aprRange, uptimes] = await Promise.all([
    caps.staking
      ? getAprRange(
          chain,
          chainParams?.distribution?.communityTax ?? null,
          validators.map((v) => v.tokens)
        ).catch(() => null)
      : null,
    adapter.getUptime(validators).catch(() => null),
  ]);
  const ratios = uptimes
    ? [...uptimes.values()].map((u) => u.ratio).filter((r): r is number => r !== null)
    : [];
  const avgUptime = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

  const bricks: BrickSpec[] = [];

  bricks.push({
    key: "height",
    label: "Latest block",
    value: overview.height ? Number(overview.height).toLocaleString() : "—",
    sub: "—",
    live: "height",
    lead: true,
    // Follows the live height, so the tile opens the block it is showing.
    href: overview.height ? `${base}/blocks/${overview.height}` : `${base}/blocks`,
    liveHref: "block",
  });

  bricks.push({
    key: "txs",
    label: "Txs in block",
    value: overview.txCount === null ? "—" : String(overview.txCount),
    sub: "at current height",
    live: "txCount",
    href: `${base}/txs`,
  });

  if (overview.activeValidators !== null) {
    // Without staking, weight is assigned per validator; its total is the
    // figure worth stating beside the count.
    const totalPower = caps.stakeWeighted
      ? null
      : validators.reduce((sum, v) => sum + Number(v.tokens || 0), 0);
    bricks.push({
      key: "validators",
      label: "Validators",
      value: num(overview.activeValidators),
      sub: totalPower ? `${totalPower.toLocaleString()} voting power` : "in the active set",
      href: `${base}/validators`,
    });
  }

  // Smallest number of validators that together exceed 1/3 of voting power,
  // enough to halt the chain.
  const nakamoto = validators.findIndex((v) => v.cumulativePower > 1 / 3) + 1;
  if (caps.stakeWeighted && nakamoto > 0) {
    bricks.push({
      key: "nakamoto",
      label: "Nakamoto",
      value: String(nakamoto),
      sub: "validators to halt",
      href: `${base}/validators`,
    });
  }

  if (caps.staking) {
    const names = new Map<string, { moniker: string; operator: string }>();
    for (const v of validators) {
      const ids = v.consensusPubkey ? consensusIdsFromPubkey(v.consensusPubkey, chain.bech32Prefix) : null;
      if (ids) names.set(ids.valcons, { moniker: v.moniker, operator: v.operatorAddress });
    }
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const lastWeek = jailings?.filter((j) => Date.parse(j.time) >= weekAgo).length ?? null;
    bricks.push({
      key: "jailings",
      label: "Recent jailings",
      value: lastWeek === null ? "N/A" : String(lastWeek),
      sub: lastWeek === null ? "" : "last 7 days",
      tone: lastWeek ? "bad" : undefined,
      rows: (jailings ?? []).map((j) => {
        const who = names.get(j.consAddr);
        return {
          label: `#${j.height.toLocaleString()} · ${new Date(j.time).toLocaleDateString()}`,
          value: `${who?.moniker ?? j.consAddr}${j.kind === "tombstoned" ? " · tombstoned" : ""}`,
          href: who ? `${base}/validators/${who.operator}` : `${base}/blocks/${j.height}`,
        };
      }),
    });
  }

  if (overview.bondedRatio !== null) {
    bricks.push({
      key: "bonded",
      href: `${base}/validators`,
      label: "Bonded",
      value: pct(overview.bondedRatio),
      sub: "of total supply",
      rows: kept([
        {
          label: "Bonded",
          value: overview.bondedTokens
            ? `${formatToken(overview.bondedTokens, chain.exponent)} ${symbol}`
            : "—",
          mono: true,
        },
        {
          label: "Total supply",
          value: overview.supply
            ? `${formatToken(overview.supply, chain.exponent)} ${symbol}`
            : "—",
          mono: true,
        },
        { label: "Ratio", value: pct(overview.bondedRatio), mono: true },
        {
          label: "Measured against",
          value: "Total supply, not the staking pool alone.",
        },
      ]),
    });
  }

  if (market) {
    bricks.push({
      key: "price",
      label: symbol,
      value: formatUsd(market.usd),
      sub:
        market.change24h !== null
          ? `${market.change24h >= 0 ? "+" : ""}${market.change24h.toFixed(2)}% 24h`
          : undefined,
      tone:
        market.change24h === null ? undefined : market.change24h >= 0 ? "ok" : "bad",
      rows: kept([
        { label: "Price", value: formatUsd(market.usd), mono: true },
        {
          label: "Market cap",
          value: market.marketCapUsd ? formatUsdCompact(market.marketCapUsd) : "—",
          mono: true,
        },
        {
          label: "24h change",
          value: market.change24h !== null ? `${market.change24h.toFixed(2)}%` : "—",
          mono: true,
        },
        { label: "Denom", value: chain.denom, mono: true },
      ]),
    });
  }

  if (chain.feeDenom && feeMarket) {
    bricks.push({
      key: "fee-price",
      label: feeSymbol,
      value: formatUsd(feeMarket.usd),
      sub:
        feeMarket.change24h !== null
          ? `${feeMarket.change24h >= 0 ? "+" : ""}${feeMarket.change24h.toFixed(2)}% 24h`
          : "fee token",
      tone:
        feeMarket.change24h === null
          ? undefined
          : feeMarket.change24h >= 0
            ? "ok"
            : "bad",
      rows: kept([
        { label: "Price", value: formatUsd(feeMarket.usd), mono: true },
        {
          label: "Market cap",
          value: feeMarket.marketCapUsd ? formatUsdCompact(feeMarket.marketCapUsd) : "—",
          mono: true,
        },
        { label: "Denom", value: chain.feeDenom, mono: true },
        { label: "Pays", value: "Transaction fees" },
      ]),
    });
  }

  if (overview.supply) {
    bricks.push({
      key: "supply",
      label: `${symbol} supply`,
      value: formatToken(overview.supply, chain.exponent),
      sub: chain.feeDenom ? "staking & governance" : "total supply",
      rows: kept([
        {
          label: `${symbol} supply`,
          value: `${formatToken(overview.supply, chain.exponent)} ${symbol}`,
          mono: true,
        },
        { label: "Base denom", value: chain.denom, mono: true },
        { label: "Exponent", value: String(chain.exponent), mono: true },
        ...(chain.feeDenom
          ? [
              {
                label: `${feeSymbol} supply`,
                value: feeSupply
                  ? `${formatToken(feeSupply, chain.exponent)} ${feeSymbol}`
                  : "—",
                mono: true,
              },
              {
                label: `${feeSymbol} cap`,
                value: chain.feeSupplyCap ? chain.feeSupplyCap.toLocaleString() : "—",
                mono: true,
              },
            ]
          : []),
      ]),
    });
  }

  if (economics?.stakingApr != null) {
    bricks.push({
      key: "apr",
      href: `${base}/validators`,
      label: "Staking APR",
      value: aprRange
        ? `${(aprRange.lo * 100).toFixed(0)}–${(aprRange.hi * 100).toFixed(0)}%`
        : pct(economics.stakingApr),
      sub: aprRange ? "by validator size" : "before commission",
      rows: kept([
        ...(aprRange
          ? [
              { label: "Largest validator", value: pct(aprRange.lo), mono: true },
              { label: "Smallest validator", value: pct(aprRange.hi), mono: true },
            ]
          : []),
        { label: "Gross APR", value: pct(economics.stakingApr), mono: true },
        {
          label: "After min commission",
          value: pct(economics.stakingAprAfterMinCommission),
          mono: true,
        },
        {
          label: "Minimum commission",
          value: pct(chainParams?.staking?.minCommissionRate),
          mono: true,
        },
        {
          label: "Community tax",
          value: pct(chainParams?.distribution?.communityTax),
          mono: true,
        },
      ]),
    });
  }

  if (economics?.communityPool) {
    const poolShare =
      overview.supply && Number(overview.supply) > 0
        ? `${((Number(economics.communityPool) / Number(overview.supply)) * 100).toFixed(2)}% of supply`
        : undefined;
    bricks.push({
      key: "pool",
      label: "Community pool",
      value: formatToken(economics.communityPool, chain.exponent),
      sub: poolShare,
      rows: kept([
        {
          label: "Balance",
          value: `${formatToken(economics.communityPool, chain.exponent)} ${symbol}`,
          mono: true,
        },
        { label: "Share of supply", value: poolShare ?? "—", mono: true },
        {
          label: "Value",
          value: market
            ? formatUsdCompact(
                (Number(economics.communityPool) / 10 ** chain.exponent) * market.usd
              )
            : "—",
          mono: true,
        },
        { label: "Counted", value: "Native denom only — IBC dust excluded." },
      ]),
    });
  }

  // Network is always available: it is config plus one GitHub read.
  const networkRows = kept([
    { label: "Network ID", value: chain.chainId, mono: true },
    { label: "Base denom", value: chain.denom, mono: true },
    { label: "Address prefix", value: chain.bech32Prefix, mono: true },
    { label: "Network", value: chain.network },
    {
      label: "Latest release",
      value: release?.tag ?? "—",
      mono: true,
      ...(release?.url ? { href: release.url } : {}),
    },
    ...(chain.website
      ? [
          {
            label: "Website",
            value: chain.website.replace(/^https?:\/\//, ""),
            href: chain.website,
          },
        ]
      : []),
    ...(chain.repo
      ? [
          {
            label: "Repository",
            value: chain.repo.replace(/^https?:\/\//, ""),
            href: chain.repo,
          },
        ]
      : []),
  ]);
  bricks.push({
    key: "network",
    label: "Version",
    value: release?.tag ?? chain.bech32Prefix,
    sub: release ? "latest release" : "address prefix",
    count: networkRows.length,
    rows: networkRows,
  });

  if (chainParams?.staking) {
    const s = chainParams.staking;
    const rows = kept([
      { label: "Unbonding period", value: humanDuration(s.unbondingTime), mono: true },
      { label: "Max validators", value: num(s.maxValidators), mono: true },
      { label: "Min commission", value: pct(s.minCommissionRate), mono: true },
      { label: "Bond denom", value: s.bondDenom ?? "—", mono: true },
      { label: "Max unbonding entries", value: num(s.maxEntries), mono: true },
      { label: "Historical entries", value: num(s.historicalEntries), mono: true },
    ]);
    bricks.push({
      key: "staking",
      label: "Staking",
      value: humanDuration(s.unbondingTime),
      sub: "unbonding period",
      count: rows.length,
      rows,
    });
  }

  if (chainParams?.slashing) {
    const s = chainParams.slashing;
    const rows = kept([
      {
        label: "Jailed after missing",
        value: missableBlocks(s.signedBlocksWindow, s.minSignedPerWindow),
        mono: true,
      },
      { label: "Measured over", value: `${num(s.signedBlocksWindow)} blocks`, mono: true },
      {
        label: "Jailed for at least",
        value: `${humanDuration(s.downtimeJailDuration)}, then may unjail`,
      },
      { label: "Slash: downtime", value: pct(s.slashFractionDowntime, 4), mono: true },
      { label: "Slash: double sign", value: pct(s.slashFractionDoubleSign), mono: true },
    ]);
    bricks.push({
      key: "slashing",
      label: "Slashing",
      value: pct(s.slashFractionDoubleSign),
      sub: "double sign penalty",
      count: rows.length,
      rows,
    });
  }

  if (chainParams?.mint) {
    const m = chainParams.mint;
    const rows = kept([
      { label: "Current inflation", value: pct(m.inflation), mono: true },
      {
        label: "Range",
        value:
          m.inflationMin !== null && m.inflationMax !== null
            ? `${pct(m.inflationMin)} – ${pct(m.inflationMax)}`
            : "—",
        mono: true,
      },
      { label: "Goal bonded", value: pct(m.goalBonded), mono: true },
      { label: "Blocks per year", value: num(m.blocksPerYear), mono: true },
    ]);
    bricks.push({
      key: "inflation",
      label: "Inflation",
      value: pct(m.inflation),
      sub: "annual, current",
      count: rows.length,
      rows,
    });
  }

  if (chainParams?.distribution) {
    const d = chainParams.distribution;
    const rows = kept([
      { label: "Community tax", value: pct(d.communityTax), mono: true },
      {
        label: "Separate withdraw address",
        value:
          d.withdrawAddrEnabled === null
            ? "—"
            : d.withdrawAddrEnabled
              ? "Allowed"
              : "Disabled",
      },
    ]);
    bricks.push({
      key: "distribution",
      label: "Distribution",
      value: pct(d.communityTax),
      sub: "community tax",
      count: rows.length,
      rows,
    });
  }

  bricks.push({
    key: "uptime",
    href: `${base}/validators`,
    label: "Network uptime",
    value: avgUptime !== null ? `${(avgUptime * 100).toFixed(2)}%` : "N/A",
    sub: `${validators.length} validators`,
    tone: avgUptime !== null && avgUptime >= 0.99 ? "ok" : undefined,
  });

  // The overview shows five figures; the rest live on their own tabs.
  const KEEP = ["network", "supply", "pool", "apr", "uptime"];
  const shown = KEEP.flatMap((k) => bricks.filter((b) => b.key === k));

  // The live lists under the tiles: this is where blocks and transactions
  // are browsed now, with every column their own tabs had.
  const named = await withProposerLogos(
    chain,
    nameProposers(recentBlocks, validators, chain.bech32Prefix),
    validators
  );
  const lowest = named.length > 0 ? Number(named[named.length - 1].height) : null;
  const txInitial = recentTxs
    ? {
        ...recentTxs,
        denoms: chain.kind === "cosmos" ? await denomsForTxs(chain, recentTxs.txs) : [],
      }
    : null;

  return (
    <PageFrame
      title={chain.prettyName}
      sub={chain.chainId}
      accent={accent}
      emblem={
        logoFor(chain) ? (
          <Image
            src={logoFor(chain)!}
            alt=""
            width={34}
            height={34}
            className="h-[34px] w-[34px] rounded-full object-contain"
          />
        ) : undefined
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="shrink-0">
          <BrickBoard
            chainId={chain.chainId}
            accent={accent}
            bricks={shown}
            head={overview}
            size="lg"
          />
        </div>
        {/* Side by side, filling the screen, from tablet width up. On a phone
            each list gets a usable height and this area scrolls instead. */}
        <div
          className={`flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-1 lg:grid lg:gap-3 lg:overflow-hidden lg:pb-0 ${
            txInitial ? "lg:grid-cols-2" : ""
          }`}
        >
          <section className="flex h-[30rem] shrink-0 flex-col gap-2 lg:h-auto lg:min-h-0">
            <h2 className="font-display shrink-0 text-[15px] font-semibold tracking-[-0.01em]">
              Blocks
            </h2>
            <div className="min-h-0 flex-1">
              <BlocksTable
                chainId={chain.chainId}
                accent={accent}
                initialBlocks={named}
                footer={
                  lowest && lowest > 1 ? (
                    <Link
                      href={`/${chain.chainId}/blocks?before=${lowest}`}
                      aria-label="Older blocks"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground"
                    >
                      Older <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  ) : null
                }
              />
            </div>
          </section>
          {txInitial ? (
            <section className="flex h-[30rem] shrink-0 flex-col gap-2 lg:h-auto lg:min-h-0">
              <h2 className="font-display shrink-0 text-[15px] font-semibold tracking-[-0.01em]">
                Transactions
              </h2>
              <div className="min-h-0 flex-1">
                <TxsTable
                  chainId={chain.chainId}
                  accent={accent}
                  denoms={chainDenoms(chain)}
                  initial={txInitial}
                />
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </PageFrame>
  );
}
