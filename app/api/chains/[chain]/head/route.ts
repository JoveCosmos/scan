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

  // Coalesced: concurrent viewers polling this share one upstream request.
  const overview = await cached(`head:${chainId}`, 2000, () =>
    getAdapter(chain).getOverview()
  );

  return NextResponse.json(overview, {
    headers: { "cache-control": "no-store" },
  });
}
