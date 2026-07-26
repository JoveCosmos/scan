import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { getRecentTxs } from "@/lib/txs";

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

  const result = await getRecentTxs(chain);

  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
