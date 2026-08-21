import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, chainDenoms, accentFor } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { getAdapter } from "@/lib/adapter";
import { PageFrame } from "@/components/page-frame";
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
  // Not offered at this chain's tier, so the route 404s rather than
  // staying reachable by URL after the tab is hidden.
  if (!policyFor(chain).txs) notFound();

  const initial = await getAdapter(chain).getRecentTxs();

  return (
    <PageFrame
      title="Transactions"
      sub={
        initial.scannedBlocks > 0
          ? `Last ${initial.scannedBlocks} blocks to ${
              initial.headHeight ? Number(initial.headHeight).toLocaleString() : "head"
            }`
          : chain.prettyName
      }
      accent={accentFor(chain)}
    >
      <TxsTable
        chainId={chain.chainId}
        accent={accentFor(chain)}
        denoms={chainDenoms(chain)}
        initial={initial}
      />
    </PageFrame>
  );
}
