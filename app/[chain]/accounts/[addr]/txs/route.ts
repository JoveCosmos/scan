import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { decodeParam } from "@/lib/format";
import type { AddressKind } from "@/lib/address-kind";
import { buildHistoryRows } from "../history-rows";

export const dynamic = "force-dynamic";

const KINDS = new Set(["user", "module", "vesting", "escrow", "contract", "ica"]);

/** One older page of an account's history, as ready-built deck rows. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ chain: string; addr: string }> }
) {
  const { chain: chainId, addr } = await params;
  const chain = getChain(chainId);
  if (!chain) return NextResponse.json({ error: "unknown chain" }, { status: 404 });

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  if (!cursor || !/^(i:\d+:[0-9A-Fa-f]+|p:\d+)$/.test(cursor)) {
    return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  }
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam && KINDS.has(kindParam) ? (kindParam as AddressKind["kind"]) : undefined;

  const address = decodeParam(addr).toLowerCase();
  const res = await getAdapter(chain).getAccountTxs(address, { cursor, kind });
  if (res.failed) return NextResponse.json({ error: "unavailable" }, { status: 502 });

  return NextResponse.json({
    rows: buildHistoryRows(chain, address, res.txs),
    next: res.next ?? null,
  });
}
