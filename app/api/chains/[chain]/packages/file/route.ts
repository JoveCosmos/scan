import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { gnoPackage, gnoSources, isPackagePath } from "@/lib/gno-packages";

export const dynamic = "force-dynamic";

/** One file of a gno.land package, for the source view: ?path=gno.land/r/…&file=x.gno. */
export async function GET(req: Request, { params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") return NextResponse.json({ error: "unknown chain" }, { status: 404 });
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  const file = url.searchParams.get("file") ?? "";
  if (!isPackagePath(path) || !/^[\w.-]{1,200}$/.test(file)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const pkg = await gnoPackage(chain, path).catch(() => undefined);
  if (pkg === undefined) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  if (!pkg || !pkg.files.includes(file)) return NextResponse.json({ error: "no such file" }, { status: 404 });
  // The whole package is read and kept for a day: whoever opens one file
  // usually opens the next.
  const source = (await gnoSources(chain, pkg)).find((f) => f.name === file)?.source ?? null;
  if (source === null) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json({ source }, { headers: { "cache-control": "public, max-age=3600" } });
}
