import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getAllChains,
  getChain,
  symbolFor,
  symbolForDenom,
  accentFor,
} from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { getAdapter } from "@/lib/adapter";
import { LiveOverview } from "@/components/live-overview";
import { Suspense } from "react";
import {
  getChainParams,
  getNodeInfo,
  getSupplyOf,
  humanDuration,
} from "@/lib/params";
import { getLatestRelease, isBehind } from "@/lib/github";
import {
  getMarketDataById,
  formatUsd,
  formatUsdCompact,
  type MarketData,
} from "@/lib/market";
import { ChainEconomics } from "@/components/chain-economics";
import { LoadingPanel } from "@/components/loading-panel";

/** An external link row — chain homepage, repository. */
function ParamLink({ label, href }: { label: string; href: string }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3 last:border-0 sm:grid-cols-[260px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 break-all font-mono text-sm text-primary hover:underline"
        >
          {href.replace(/^https?:\/\//, "")}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      </dd>
    </div>
  );
}

/**
 * How many blocks a validator may miss before being jailed.
 *
 * The chain states a minimum share it must *sign*, which inverts awkwardly: on
 * Cosmos Hub "5% of 10,000" means you are jailed only after missing more than
 * 9,500 of the last 10,000 blocks. Stating the miss budget directly stops the
 * parameter reading as a far stricter rule than it is.
 */
function missableBlocks(
  window: number | null,
  minSigned: number | null
): string {
  if (window === null || minSigned === null) return "—";
  const allowed = Math.floor(window * (1 - minSigned));
  return `${allowed.toLocaleString()} of ${window.toLocaleString()} blocks`;
}

/** A round whole-token count in words: 1_000_000_000 -> "1 billion". */
function bigCount(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)} billion`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)} million`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(2)}k`;
  return n.toLocaleString();
}

/** Cosmos decimal (0.05) as a percentage. */
function pct(value: number | null, decimals = 2): string {
  return value === null ? "—" : `${(value * 100).toFixed(decimals)}%`;
}

function ParamSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">{title}</h2>
      {note ? <p className="mb-3 -mt-2 text-xs text-muted-foreground">{note}</p> : null}
      <div className="gata-panel">
        <dl>{children}</dl>
      </div>
    </section>
  );
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3 last:border-0 sm:grid-cols-[260px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}

export function generateStaticParams() {
  return getAllChains().map((chain) => ({ chain: chain.chainId }));
}

export const dynamicParams = true;

// An explorer always shows head-of-chain state, so never prerender this at build
// time — a public node being down must not be able to fail the build.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain?.prettyName ?? "Chain" };
}

function PriceCard({
  symbol,
  market,
  accent,
  index,
}: {
  symbol: string;
  market: MarketData;
  accent: string;
  index: number;
}) {
  const up = market.change24h !== null && market.change24h >= 0;
  return (
    <div
      className="gata-panel gata-rise p-5"
      style={{
        ["--panel-accent" as string]: accent,
        animationDelay: `${240 + index * 60}ms`,
      }}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {symbol}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold">{formatUsd(market.usd)}</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs">
        {market.change24h !== null ? (
          <span className={up ? "text-[var(--gata-green)]" : "text-[var(--gata-burn)]"}>
            {up ? "+" : ""}
            {market.change24h.toFixed(2)}% 24h
          </span>
        ) : null}
        {market.marketCapUsd !== null ? (
          <span className="text-muted-foreground">
            {formatUsdCompact(market.marketCapUsd)} cap
          </span>
        ) : null}
      </p>
    </div>
  );
}

export default async function ChainParamsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const adapter = getAdapter(chain);
  const [
    overview,
    chainParams,
    nodeInfo,
    release,
    feeSupply,
    market,
    feeMarket,
  ] = await Promise.all([
    adapter.getOverview(),
    // gno has none of these modules; the sections simply do not render.
    adapter.capabilities.staking ? getChainParams(chain) : Promise.resolve(null),
    adapter.capabilities.staking
      ? getNodeInfo(chain).catch(() => null)
      : Promise.resolve(null),
    getLatestRelease(chain.repo).catch(() => null),
    chain.feeDenom
      ? getSupplyOf(chain, chain.feeDenom).catch(() => null)
      : Promise.resolve(null),
    getMarketDataById(chain.coingeckoId).catch(() => null),
    getMarketDataById(chain.feeCoingeckoId).catch(() => null),
  ]);

  const symbol = symbolFor(chain);
  const feeSymbol = chain.feeDenom ? symbolForDenom(chain.feeDenom) : "";
  const accent = accentFor(chain);

  // One price box per token that has a market. AtomOne gets two (ATONE,
  // PHOTON); a single-token chain gets one; a testnet with no listing gets none.
  const priceCards = [
    market ? { symbol, market } : null,
    chain.feeDenom && feeMarket ? { symbol: feeSymbol, market: feeMarket } : null,
  ].filter((c): c is { symbol: string; market: NonNullable<typeof market> } => c !== null);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-7 flex items-center gap-3">
        <span
          className="h-9 w-1 rounded-full"
          style={{ background: accent, boxShadow: `0 0 16px ${accent}` }}
        />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{chain.prettyName}</h1>
          <p className="font-mono text-sm text-muted-foreground">{chain.chainId}</p>
        </div>
      </div>

      <LiveOverview
        chainId={chain.chainId}
        accent={accent}
        initialData={overview}
      />

      {priceCards.length > 0 ? (
        // One row, one column per token — never wraps to a second row.
        <div
          className="mt-6 grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${priceCards.length}, minmax(0, 1fr))`,
          }}
        >
          {priceCards.map((card, i) => (
            <PriceCard
              key={card.symbol}
              symbol={card.symbol}
              market={card.market}
              accent={accent}
              index={i}
            />
          ))}
        </div>
      ) : null}

      {chain.feeDenom ? (
        <ParamSection
          title="Tokens"
          note="AtomOne separates the two: Atone token secures the chain and votes, the Photon pays fees."
        >
          <ParamRow
            label={`${symbol} - ${chain.denom}`}
            value={`${formatToken(overview.supply, chain.exponent)} ${symbol}  ·  staking & governance`}
          />
          <ParamRow
            label={`${feeSymbol} - ${chain.feeDenom}`}
            value={`${
              feeSupply ? formatToken(feeSupply, chain.exponent) : "—"
            } ${feeSymbol}  ·  transaction fees${
              chain.feeSupplyCap
                ? `  ·  supply cap ${bigCount(chain.feeSupplyCap)}`
                : ""
            }`}
          />
        </ParamSection>
      ) : null}

      {adapter.capabilities.staking ? (
        <Suspense
          fallback={
            // Mirrors ChainEconomics' own <section className="mt-6"> and
            // heading. Without the wrapper the fallback had no top margin and
            // collided with the supply cards above it, then the layout jumped
            // when the real section replaced it.
            <section className="mt-6">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                Tokenomics
              </h2>
              <LoadingPanel label="Loading tokenomics…" rows={4} />
            </section>
          }
        >
          <ChainEconomics
            chain={chain}
            communityTax={chainParams?.distribution?.communityTax ?? null}
            minCommission={chainParams?.staking?.minCommissionRate ?? null}
            supply={overview.supply}
            market={market}
          />
        </Suspense>
      ) : null}

      <ParamSection title="Network">
        <ParamRow label="Chain ID" value={chain.chainId} />
        <ParamRow label="Base denom" value={chain.denom} />
        <ParamRow label="Address prefix" value={chain.bech32Prefix} />
        {nodeInfo?.version ? (
          <ParamRow
            // "Node version" read as the chain's version; it is the version of
            // whichever public node answered, which can trail the release by
            // weeks when an upgrade needs no coordination.
            label="Node running"
            value={`${nodeInfo.app ?? "node"} ${nodeInfo.version}${
              nodeInfo.cosmosSdkVersion
                ? `  ·  Cosmos SDK ${nodeInfo.cosmosSdkVersion}`
                : ""
            }`}
          />
        ) : null}
        {release ? (
          <ParamRow
            label="Latest release"
            value={`${release.tag}${
              isBehind(nodeInfo?.version ?? null, release.tag)
                ? "  ·  the node above has not upgraded yet"
                : ""
            }`}
          />
        ) : null}
        {chain.website ? (
          <ParamLink label="Website" href={chain.website} />
        ) : null}
        {chain.repo ? <ParamLink label="Repository" href={chain.repo} /> : null}
      </ParamSection>

      {chainParams?.staking ? (
        <ParamSection title="Staking">
          <ParamRow label="Unbonding period" value={humanDuration(chainParams.staking.unbondingTime)} />
          <ParamRow label="Max validators" value={chainParams.staking.maxValidators?.toLocaleString() ?? "—"} />
          <ParamRow label="Min commission" value={pct(chainParams.staking.minCommissionRate)} />
          <ParamRow label="Bond denom" value={chainParams.staking.bondDenom ?? "—"} />
          <ParamRow label="Max unbonding entries" value={chainParams.staking.maxEntries?.toLocaleString() ?? "—"} />
        </ParamSection>
      ) : null}

      {chainParams?.slashing ? (
        <ParamSection title="Slashing">
          <ParamRow
            label="Jailed after missing"
            // The parameter is a floor on blocks signed; what people want to
            // know is how many they may miss before being jailed.
            value={missableBlocks(
              chainParams.slashing.signedBlocksWindow,
              chainParams.slashing.minSignedPerWindow
            )}
          />
          <ParamRow
            label="Measured over"
            value={`${chainParams.slashing.signedBlocksWindow?.toLocaleString() ?? "—"} blocks`}
          />
          <ParamRow
            // Not the downtime that causes jailing — the wait afterwards. The
            // old label read as "10 minutes of downtime gets you slashed".
            label="Jailed for at least"
            value={`${humanDuration(chainParams.slashing.downtimeJailDuration)}, then may unjail`}
          />
          <ParamRow label="Slash: downtime" value={pct(chainParams.slashing.slashFractionDowntime, 4)} />
          <ParamRow label="Slash: double sign" value={pct(chainParams.slashing.slashFractionDoubleSign)} />
        </ParamSection>
      ) : null}

      {chainParams?.mint ? (
        <ParamSection title="Inflation">
          <ParamRow label="Current inflation" value={pct(chainParams.mint.inflation)} />
          <ParamRow label="Inflation range" value={
            chainParams.mint.inflationMin !== null && chainParams.mint.inflationMax !== null
              ? `${pct(chainParams.mint.inflationMin)} – ${pct(chainParams.mint.inflationMax)}`
              : "—"
          } />
          <ParamRow label="Goal bonded" value={pct(chainParams.mint.goalBonded)} />
          <ParamRow label="Blocks per year" value={chainParams.mint.blocksPerYear?.toLocaleString() ?? "—"} />
        </ParamSection>
      ) : null}

      {chainParams?.distribution ? (
        <ParamSection title="Distribution">
          <ParamRow label="Community tax" value={pct(chainParams.distribution.communityTax)} />
          <ParamRow
            label="Separate withdraw address"
            value={chainParams.distribution.withdrawAddrEnabled === null ? "—" : chainParams.distribution.withdrawAddrEnabled ? "Allowed" : "Disabled"}
          />
        </ParamSection>
      ) : null}
    </main>
  );
}
