import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { cached } from "@/lib/cache";
import { nameProposers } from "@/lib/blocks";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string }> }
) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);

  if (!chain) {
    return NextResponse.json({ error: `Unknown chain "${chainId}"` }, { status: 404 });
  }

  const adapter = getAdapter(chain);

  // One upstream fan-out per interval regardless of how many tabs are open.
  // Proposer names come from the adapter's own 30s-cached validator set, so
  // naming fifteen blocks costs nothing per poll.
  const blocks = await cached(`blocks:${chainId}`, 2500, async () => {
    const [recent, validators] = await Promise.all([
      adapter.getRecentBlocks(),
      adapter.getValidators().catch(() => []),
    ]);
    return nameProposers(recent, validators, chain.bech32Prefix);
  });

  return NextResponse.json({ blocks }, { headers: { "cache-control": "no-store" } });
}
