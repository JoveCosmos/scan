import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { withinBudget } from "@/lib/cache";
import { gnoTxTimes, realmByAddress } from "@/lib/gno-packages";
import { tokenMeta, tokenTransfersPage } from "@/lib/gno-token-data";
import { gnoNames } from "@/lib/gno-users";
import { transferRows } from "@/app/[chain]/tokens/rows";

export const dynamic = "force-dynamic";

/** The next page of a token's transfers: ?token=<key>&before=<cursor>. */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const url = new URL(req.url);
  const key = url.searchParams.get("token") ?? "";
  const cursor = url.searchParams.get("before") ?? undefined;
  const [meta, names, realms] = await Promise.all([
    tokenMeta(chain),
    withinBudget(gnoNames(chain), 1500, null),
    withinBudget(realmByAddress(chain), 1500, null),
  ]);
  if (!meta) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  const token = meta.get(key);
  if (!token) return NextResponse.json({ error: "no such token" }, { status: 404 });
  const page = await tokenTransfersPage(chain, key, cursor);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  const times = await withinBudget(
    gnoTxTimes(chainId, [...new Set(page.transfers.map((t) => t.txHash))]),
    2000,
    new Map<string, string>()
  );
  return NextResponse.json({ rows: transferRows(chainId, token, page.transfers, names, realms, times), next: page.next });
}
