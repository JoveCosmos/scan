import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { powerEventsBefore, VALIDATOR_PAGE } from "@/lib/indexer-validator";
import { decodeParam } from "@/lib/format";
import { powerRows } from "../rows";

export const dynamic = "force-dynamic";

/** The next older page of a validator's power events, below `before`. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ chain: string; addr: string }> }
) {
  const { chain: chainId, addr } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "cosmos") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const before = Number(new URL(req.url).searchParams.get("before"));
  if (!Number.isSafeInteger(before) || before < 1) return NextResponse.json({ error: "bad cursor" }, { status: 400 });

  const operator = decodeParam(addr).toLowerCase();
  if (!/^[a-z0-9]+valoper1[0-9a-z]{38,58}$/.test(operator)) {
    return NextResponse.json({ error: "bad address" }, { status: 400 });
  }
  const events = await powerEventsBefore(chainId, operator, before);
  if (!events) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  const last = events.at(-1);
  return NextResponse.json({
    rows: powerRows(chain, operator, events),
    next: events.length >= VALIDATOR_PAGE && last ? String(last.height) : null,
  });
}
