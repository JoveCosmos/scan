import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { gnoRealmCallsBefore, isPackagePath, isRealm } from "@/lib/gno-packages";
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
  const before = Number(url.searchParams.get("before"));
  if (!isPackagePath(path) || !isRealm(path) || !Number.isSafeInteger(before) || before < 1) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const [page, names] = await Promise.all([
    gnoRealmCallsBefore(chain, path, before),
    withinBudget(gnoNames(chain), 1500, null),
  ]);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json({
    rows: callRows(chainId, page.calls, names),
    next: page.next !== null ? String(page.next) : null,
  });
}
