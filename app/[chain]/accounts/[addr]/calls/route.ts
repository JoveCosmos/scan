import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { decodeParam } from "@/lib/format";
import { CALLS_PAGE } from "@/lib/gno-packages";
import { gnoIndexed, indexedAccountCalls, parseCallCursor } from "@/lib/gno-index";
import { accountCallRows } from "../call-rows";

export const dynamic = "force-dynamic";

/** A page of the realm calls and runs a gno.land account made: the newest, or those below ?before=<cursor>. */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string; addr: string }> }) {
  const { chain: chainId, addr } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const address = decodeParam(addr).trim().toLowerCase();
  if (!/^g1[a-z0-9]{38}$/.test(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  const raw = new URL(req.url).searchParams.get("before");
  const before = raw ? parseCallCursor(raw) : null;
  if (raw && !before) return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  const pool = await gnoIndexed(chainId, "gno_tx_msg");
  if (!pool) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  const page = await indexedAccountCalls(pool, chainId, address, CALLS_PAGE, before ?? undefined).catch(() => null);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json({ rows: accountCallRows(chainId, page.calls), next: page.next });
}
