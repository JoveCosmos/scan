import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { nameProposers } from "@/lib/blocks";
import { PageFrame } from "@/components/page-frame";
import { BlocksTable } from "@/components/blocks-table";

export const dynamic = "force-dynamic";

export default async function BlocksPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const adapter = getAdapter(chain);
  const [blocks, validators] = await Promise.all([
    adapter.getRecentBlocks(),
    adapter.getValidators().catch(() => []),
  ]);

  return (
    <PageFrame
      title="Blocks"
      sub={`Streaming from ${chain.prettyName}`}
      accent={accentFor(chain)}
    >
      <BlocksTable
        chainId={chain.chainId}
        accent={accentFor(chain)}
        initialBlocks={nameProposers(blocks, validators, chain.bech32Prefix)}
      />
    </PageFrame>
  );
}
