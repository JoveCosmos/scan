import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { CALLS_PAGE, gnoRealmCallsBefore, isPackagePath, isRealm } from "@/lib/gno-packages";
import { gnoIndexed, indexedCalls, parseCallCursor } from "@/lib/gno-index";
import { callRows } from "@/app/[chain]/packages/rows";
import { withinBudget } from "@/lib/cache";
import { gnoNames } from "@/lib/gno-users";

export const dynamic = "force-dynamic";

/** The next older page of a realm's calls: ?path=gno.land/r/…&before=<height>. */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  const raw = url.searchParams.get("before") ?? "";
  if (!isPackagePath(path) || !isRealm(path)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const names = withinBudget(gnoNames(chain), 1500, null);

  // Our index's keyset cursor (see gnoRealmCalls), or a block height for the
  // tx-indexer's windows.
  const keyset = parseCallCursor(raw);
  if (keyset) {
    const pool = await gnoIndexed(chainId, "gno_tx_msg");
    if (!pool) return NextResponse.json({ error: "unavailable" }, { status: 502 });
    const page = await indexedCalls(pool, chainId, path, CALLS_PAGE, keyset).catch(() => null);
    if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
    return NextResponse.json({ rows: callRows(chainId, page.calls, await names), next: page.next });
  }

  const before = Number(raw);
  if (!Number.isSafeInteger(before) || before < 1) return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  const page = await gnoRealmCallsBefore(chain, path, before);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json({
    rows: callRows(chainId, page.calls, await names),
    next: page.next !== null ? String(page.next) : null,
  });
}
