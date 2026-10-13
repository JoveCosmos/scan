import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { getValidator } from "@/lib/validators";
import { consensusIdsFromPubkey } from "@/lib/uptime";
import { proposedBlocks, VALIDATOR_PAGE } from "@/lib/indexer-validator";
import { decodeParam } from "@/lib/format";
import { proposedRows } from "../rows";

export const dynamic = "force-dynamic";

/** The next older page of a validator's proposed blocks, below `before`. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ chain: string; addr: string }> }
) {
  const { chain: chainId, addr } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "cosmos") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const before = Number(new URL(req.url).searchParams.get("before"));
  if (!Number.isSafeInteger(before) || before < 1) return NextResponse.json({ error: "bad cursor" }, { status: 400 });

  const validator = await getValidator(chain, decodeParam(addr).toLowerCase());
  const ids = validator?.consensusPubkey ? consensusIdsFromPubkey(validator.consensusPubkey, chain.bech32Prefix) : null;
  if (!ids) return NextResponse.json({ error: "unknown validator" }, { status: 404 });

  const list = await proposedBlocks(chainId, ids.hex, VALIDATOR_PAGE, before);
  if (!list) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  const last = list.blocks.at(-1);
  return NextResponse.json({
    rows: proposedRows(chainId, list.blocks),
    next: list.blocks.length >= VALIDATOR_PAGE && last ? String(last.height) : null,
  });
}
