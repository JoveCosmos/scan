import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { cached } from "@/lib/cache";
import { policyFor } from "@/lib/tiers";
import { denomsForTxs } from "@/lib/txs";

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
  // The feed answers exactly where the Transactions tab does.
  if (!policyFor(chain).txs) {
    return NextResponse.json({ error: "N/A" }, { status: 404 });
  }

  // The heaviest read on the app - scans a block window - so cache it longest.
  const result = await cached(`txs:${chainId}`, 5000, async () => {
    const recent = await getAdapter(chain).getRecentTxs();
    const denoms = chain.kind === "cosmos" ? await denomsForTxs(chain, recent.txs) : [];
    return { ...recent, denoms };
  });

  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
