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

  // The heaviest read on the app — scans a block window — so cache it longest.
  const result = await cached(`txs:${chainId}`, 5000, () =>
    getAdapter(chain).getRecentTxs()
  );

  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
