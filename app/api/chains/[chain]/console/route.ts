import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { runCommand } from "@/lib/console";

export const dynamic = "force-dynamic";

/** A line typed into the console. Bounded so a paste cannot become a payload. */
const MAX_LINE = 400;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);

  if (!chain) {
    return NextResponse.json(
      { blocks: [{ kind: "error", message: `Unknown chain "${chainId}".` }] },
      { status: 404 }
    );
  }

  let line = "";
  try {
    const body = (await request.json()) as { line?: unknown };
    line = typeof body.line === "string" ? body.line.slice(0, MAX_LINE) : "";
  } catch {
    return NextResponse.json(
      { blocks: [{ kind: "error", message: "Malformed request." }] },
      { status: 400 }
    );
  }

  try {
    const result = await runCommand(chain, line);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // An endpoint that times out is the normal failure here, not a bug. The
    // console prints it like any other result and stays usable.
    return NextResponse.json(
      {
        blocks: [
          {
            kind: "error",
            message: e instanceof Error ? e.message : "The command failed.",
            hint: "The chain endpoint may be slow or down — try again.",
          },
        ],
      },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
