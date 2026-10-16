import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { withinBudget } from "@/lib/cache";
import { decodeParam } from "@/lib/format";
import { gnoAccountTransfers, gnoTokens } from "@/lib/gno-tokens";
import { gnoTxTimes, realmByAddress } from "@/lib/gno-packages";
import { gnoNames } from "@/lib/gno-users";
import { tokenTransferRows } from "../token-rows";

export const dynamic = "force-dynamic";

/** A page of a gno.land account's GRC20 transfers: the newest, or those below ?before=<height>. */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string; addr: string }> }) {
  const { chain: chainId, addr } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const address = decodeParam(addr).trim().toLowerCase();
  if (!/^g1[a-z0-9]{38}$/.test(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  const beforeParam = new URL(req.url).searchParams.get("before");
  const before = beforeParam === null ? undefined : Number(beforeParam);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
    return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  }
  const [page, tokens, names, realms] = await Promise.all([
    gnoAccountTransfers(chain, address, before),
    withinBudget(gnoTokens(chain), 1500, null),
    withinBudget(gnoNames(chain), 1500, null),
    withinBudget(realmByAddress(chain), 1500, null),
  ]);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  const times = await withinBudget(
    gnoTxTimes(chainId, [...new Set(page.transfers.map((t) => t.txHash))]),
    2000,
    new Map<string, string>()
  );
  return NextResponse.json({
    rows: tokenTransferRows(chainId, address, page.transfers, tokens, names, times, realms),
    next: page.next !== null ? String(page.next) : null,
  });
}
