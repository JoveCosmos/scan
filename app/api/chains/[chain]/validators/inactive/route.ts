import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { inactiveValidatorRows } from "@/lib/validator-rows";

export const dynamic = "force-dynamic";

/** The validators list's Inactive view, fetched when it is first opened. */
export async function GET(_request: Request, { params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) return NextResponse.json({ error: `Unknown chain "${chainId}"` }, { status: 404 });
  const rows = await inactiveValidatorRows(chain);
  return NextResponse.json({ rows }, { headers: { "cache-control": "private, max-age=60" } });
}
