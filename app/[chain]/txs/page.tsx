import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, symbolFor, chainDenoms } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { TxsTable } from "@/components/txs-table";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `Transactions · ${chain.prettyName}` : "Transactions" };
}

export default async function TxsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const initial = await getAdapter(chain).getRecentTxs();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        <p className="text-sm text-muted-foreground">
          Recent activity on {chain.prettyName}
        </p>
      </div>

      <TxsTable
        chainId={chain.chainId}
        exponent={chain.exponent}
        symbol={symbolFor(chain)}
        denom={chain.denom}
        denoms={chainDenoms(chain)}
        initial={initial}
      />
    </main>
  );
}
