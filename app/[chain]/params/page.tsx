import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllChains, getChain, symbolFor, accentFor } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { getAdapter } from "@/lib/adapter";
import { LiveOverview } from "@/components/live-overview";
import { getChainParams, humanDuration } from "@/lib/params";

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

function MetaCard({
  label,
  value,
  accent,
  index,
}: {
  label: string;
  value: string;
  accent: string;
  index: number;
}) {
  return (
    <div
      className="gata-panel gata-rise p-5"
      style={{
        ["--panel-accent" as string]: accent,
        animationDelay: `${240 + index * 60}ms`,
      }}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold">{value}</p>
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
  const [overview, chainParams] = await Promise.all([
    adapter.getOverview(),
    // gno has none of these modules; the sections simply do not render.
    adapter.capabilities.staking ? getChainParams(chain) : Promise.resolve(null),
  ]);
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

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
        exponent={chain.exponent}
        symbol={symbol}
        accent={accent}
        initialData={overview}
      />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetaCard
          index={0}
          accent={accent}
          label="Total Supply"
          value={`${formatToken(overview.supply, chain.exponent)} ${symbol}`}
        />
        <MetaCard index={1} accent={accent} label="Base Denom" value={chain.denom} />
        <MetaCard
          index={2}
          accent={accent}
          label="Address Prefix"
          value={chain.bech32Prefix}
        />
      </div>

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
        <ParamSection
          title="Slashing"
          note="What it takes to be jailed, and what it costs."
        >
          <ParamRow label="Signed blocks window" value={chainParams.slashing.signedBlocksWindow?.toLocaleString() ?? "—"} />
          <ParamRow label="Min signed per window" value={pct(chainParams.slashing.minSignedPerWindow)} />
          <ParamRow label="Downtime jail duration" value={humanDuration(chainParams.slashing.downtimeJailDuration)} />
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
