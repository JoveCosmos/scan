import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, chainDenoms, accentFor } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { getAdapter } from "@/lib/adapter";
import { PageFrame } from "@/components/page-frame";
import { SectionUnavailable } from "@/components/section-unavailable";
import { TxsTable } from "@/components/txs-table";
import { denomsForTxs } from "@/lib/txs";

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
  // The tab is shown for every network, so this says what it has instead of
  // 404ing and contradicting the rail that linked here.
  if (!policyFor(chain).txs) {
    return (
      <SectionUnavailable
        title="Transactions"
        chainId={chain.chainId}
        chainName={chain.prettyName}
        accent={accentFor(chain)}
      />
    );
  }

  const recent = await getAdapter(chain).getRecentTxs();
  const initial = {
    ...recent,
    denoms: chain.kind === "cosmos" ? await denomsForTxs(chain, recent.txs) : [],
  };

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
