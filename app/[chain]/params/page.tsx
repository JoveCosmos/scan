import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
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
import { getChainParams, getChainEconomics, getAprRange } from "@/lib/params";
import { getSupplyOf } from "@/lib/params";
import { getLatestRelease } from "@/lib/github";
import { getMarketDataById, formatUsdCompact } from "@/lib/market";
import Image from "next/image";
import { PageFrame } from "@/components/page-frame";
import { withinBudget } from "@/lib/cache";
import { BlocksTable } from "@/components/blocks-table";
import { TxsTable } from "@/components/txs-table";
import { PairPanels } from "@/components/pair-panels";
import { getPhotonState } from "@/lib/photon";
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
  value === null || value === undefined ? "-" : `${(value * 100).toFixed(decimals)}%`;

/** Drops rows whose value is a dash, so a popup never lists absent facts. */
const kept = (rows: DetailRow[]) => rows.filter((r) => r.value !== "-" && r.value !== "");

/**
 * A chain's overview: five headline figures (version, supply, community pool,
 * staking APR, network uptime), each opening its detail, and under them the
 * live Blocks and Transactions lists side by side. This is where blocks and
 * transactions are browsed; there are no separate list pages.
 *
 * The holder count is deliberately absent: it is a full scan of every account
 * with a balance and takes ~25s on AtomOne.
 */
const ACTION =
  "rounded-md border border-border bg-[var(--gata-card)] px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:border-[var(--gata-border-hi)]";

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
  const [overview, chainParams, release, feeSupply, market, validators, recentBlocks, recentTxs] =
    await Promise.all([
      adapter.getOverview(),
      caps.staking ? getChainParams(chain) : null,
      getLatestRelease(chain.repo).catch(() => null),
      chain.feeDenom ? getSupplyOf(chain, chain.feeDenom).catch(() => null) : null,
      getMarketDataById(chain.coingeckoId).catch(() => null),
      // Cached set, shared with the validators tab: feeds Nakamoto and names.
      adapter.getValidators().catch(() => []),
      // The live lists: shared caches with their polling endpoints.
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
  // Both optional and budgeted, so a cold cache never holds the page up.
  const [aprRange, uptimes] = await Promise.all([
    caps.staking
      ? withinBudget(
          getAprRange(
            chain,
            chainParams?.distribution?.communityTax ?? null,
            validators.map((v) => v.tokens)
          ),
          1500,
          null
        )
      : null,
    withinBudget(adapter.getUptime(validators), 1500, null),
  ]);
  const ratios = uptimes
    ? [...uptimes.values()].map((u) => u.ratio).filter((r): r is number => r !== null)
    : [];
  const avgUptime = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

  const bricks: BrickSpec[] = [];

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
                  : "-",
                mono: true,
              },
              {
                label: `${feeSymbol} cap`,
                value: chain.feeSupplyCap ? chain.feeSupplyCap.toLocaleString() : "-",
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
      short: "Pool",
      value: formatToken(economics.communityPool, chain.exponent),
      sub: poolShare,
      rows: kept([
        {
          label: "Balance",
          value: `${formatToken(economics.communityPool, chain.exponent)} ${symbol}`,
          mono: true,
        },
        { label: "Share of supply", value: poolShare ?? "-", mono: true },
        {
          label: "Value",
          value: market
            ? formatUsdCompact(
                (Number(economics.communityPool) / 10 ** chain.exponent) * market.usd
              )
            : "-",
          mono: true,
        },
        { label: "Counted", value: "Native denom only - IBC dust excluded." },
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
      value: release?.tag ?? "-",
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
  // AtomOne's fee token has its own page; its tile leads there.
  if (chain.photon) {
    const ph = await withinBudget(getPhotonState(chain), 1500, null);
    const cap = chain.feeSupplyCap ? chain.feeSupplyCap * 1e6 : null;
    shown.push({
      key: "photon",
      label: "PHOTON",
      value: ph?.photonSupply ? formatToken(ph.photonSupply, 6) : "N/A",
      sub:
        ph?.rate != null
          ? `1 ${symbolFor(chain)} = ${ph.rate.toFixed(2)}${cap && ph.photonSupply ? `, ${((Number(ph.photonSupply) / cap) * 100).toFixed(1)}% of cap` : ""}`
          : "fee token",
      href: `/${chain.chainId}/photon`,
    });
  }

  // The live lists under the tiles: this is where blocks and transactions
  // are browsed now, with every column their own tabs had.
  const renderedAt = Date.now();
  const named = await withProposerLogos(
    chain,
    nameProposers(recentBlocks, validators, chain.bech32Prefix),
    validators
  );
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
      actions={
        chain.indexed || chain.kind === "gno" ? (
          <div className="flex items-center gap-1.5">
            {chain.kind === "gno" ? (
              <Link href={`/${chain.chainId}/packages`} className={ACTION}>
                Packages
              </Link>
            ) : null}
            <Link href={`/${chain.chainId}/charts`} className={ACTION}>
              Charts
            </Link>
          </div>
        ) : undefined
      }
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
      {/* The one page that scrolls as a whole below lg: its figures, then both
          feeds at full height. From lg it fits the frame like every other. */}
      <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto pb-3 sm:gap-3 lg:overflow-hidden lg:pb-0">
        <div className="brick-dense shrink-0">
          <BrickBoard
            chainId={chain.chainId}
            accent={accent}
            bricks={shown}
            head={overview}
            size="lg"
            className={shown.length === 6 ? "lg:!grid-cols-6" : undefined}
          />
        </div>
        <div className="shrink-0 lg:min-h-0 lg:flex-1">
          <PairPanels
            panels={[
              {
                key: "blocks",
                label: "Blocks",
                content: (
                  <BlocksTable
                    chainId={chain.chainId}
                    accent={accent}
                    initialBlocks={named}
                    renderedAt={renderedAt}
                  />
                ),
              },
              ...(txInitial
                ? [
                    {
                      key: "txs",
                      label: "Transactions",
                      content: (
                        <TxsTable
                          chainId={chain.chainId}
                          accent={accent}
                          denoms={chainDenoms(chain)}
                          initial={txInitial}
                          renderedAt={renderedAt}
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>
    </PageFrame>
  );
}
