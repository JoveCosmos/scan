import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAllChains, getChain, symbolFor, accentFor } from "@/lib/chains";
import { getChainOverview, formatToken } from "@/lib/overview";
import { LiveOverview } from "@/components/live-overview";

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

export default async function ChainOverviewPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const overview = await getChainOverview(chain);
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
    </main>
  );
}
