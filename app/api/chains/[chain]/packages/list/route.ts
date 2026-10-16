import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { loadPackageList, packageRows } from "@/app/[chain]/packages/rows";

export const dynamic = "force-dynamic";

/** One tab of the package list, for when it is opened: ?kind=realms|packages. */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const kind = new URL(req.url).searchParams.get("kind");
  if (kind !== "realms" && kind !== "packages") return NextResponse.json({ error: "bad request" }, { status: 400 });
  const list = await loadPackageList(chain);
  if (!list.paths) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json(
    { rows: packageRows(chainId, kind === "realms" ? list.realms : list.libs, list.names) },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
