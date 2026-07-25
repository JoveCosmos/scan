import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { getRecentBlocks } from "@/lib/blocks";

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

  const blocks = await getRecentBlocks(chain);

  return NextResponse.json({ blocks }, { headers: { "cache-control": "no-store" } });
}
