import { notFound } from "next/navigation";
import { getChain } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
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

  const blocks = await getAdapter(chain).getRecentBlocks();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Blocks</h1>
        <p className="text-sm text-muted-foreground">
          Most recent blocks on {chain.prettyName}
        </p>
      </div>

      <BlocksTable chainId={chain.chainId} initialBlocks={blocks} />
    </main>
  );
}
