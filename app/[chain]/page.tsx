import { notFound } from "next/navigation";
import { getAllChains, getChain, symbolFor } from "@/lib/chains";
import { getChainOverview, formatToken } from "@/lib/overview";
import { LiveOverview } from "@/components/live-overview";
import { Card, CardHeader, CardDescription, CardTitle } from "@/components/ui/card";

export function generateStaticParams() {
  return getAllChains().map((chain) => ({ chain: chain.chainId }));
}

export const dynamicParams = true;

// An explorer always shows head-of-chain state, so never prerender this at build
// time — a public node being down must not be able to fail the build.
export const dynamic = "force-dynamic";

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

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{chain.prettyName}</h1>
        <p className="font-mono text-sm text-muted-foreground">{chain.chainId}</p>
      </div>

      <LiveOverview
        chainId={chain.chainId}
        exponent={chain.exponent}
        symbol={symbol}
        initialData={overview}
      />

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="gap-1">
            <CardDescription className="text-xs uppercase tracking-wider">
              Total Supply
            </CardDescription>
            <CardTitle className="font-mono text-2xl">
              {formatToken(overview.supply, chain.exponent)} {symbol}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="gap-1">
            <CardDescription className="text-xs uppercase tracking-wider">
              Base Denom
            </CardDescription>
            <CardTitle className="font-mono text-2xl">{chain.denom}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="gap-1">
            <CardDescription className="text-xs uppercase tracking-wider">
              Address Prefix
            </CardDescription>
            <CardTitle className="font-mono text-2xl">{chain.bech32Prefix}</CardTitle>
          </CardHeader>
        </Card>
      </div>
    </main>
  );
}
