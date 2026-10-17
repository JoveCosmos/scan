import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { CALLS_PAGE, isPackagePath, isRealm } from "@/lib/gno-packages";
import { gnoIndexed, indexedCalls, parseCallCursor } from "@/lib/gno-index";
import { callRows } from "@/app/[chain]/packages/rows";
import { withinBudget } from "@/lib/cache";
import { gnoNames } from "@/lib/gno-users";

export const dynamic = "force-dynamic";

/** The next older page of a realm's calls: ?path=gno.land/r/…&before=<keyset cursor>. */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  const raw = url.searchParams.get("before") ?? "";
  if (!isPackagePath(path) || !isRealm(path)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const names = withinBudget(gnoNames(chain), 1500, null);

  // The keyset cursor gnoRealmCalls and this route hand out.
  const keyset = parseCallCursor(raw);
  if (!keyset) return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  const pool = await gnoIndexed(chainId, "gno_tx_msg");
  if (!pool) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  const page = await indexedCalls(pool, chainId, path, CALLS_PAGE, keyset).catch(() => null);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json({ rows: callRows(chainId, page.calls, await names), next: page.next });
}
