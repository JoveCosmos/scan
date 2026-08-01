import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { cached } from "@/lib/cache";

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

  // One upstream fan-out per interval regardless of how many tabs are open.
  const blocks = await cached(`blocks:${chainId}`, 2500, () =>
    getAdapter(chain).getRecentBlocks()
  );

  return NextResponse.json({ blocks }, { headers: { "cache-control": "no-store" } });
}
