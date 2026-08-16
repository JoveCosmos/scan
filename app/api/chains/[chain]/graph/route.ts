import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { buildGraph } from "@/lib/graph";
import { cached } from "@/lib/cache";

export const dynamic = "force-dynamic";

const MAX_SEED = 200;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chain: string }> }
) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);

  if (!chain) {
    return NextResponse.json(
      { nodes: [], edges: [], seed: "", error: `Unknown chain "${chainId}".` },
      { status: 404 }
    );
  }

  const seed = (new URL(request.url).searchParams.get("seed") ?? "head").slice(0, MAX_SEED);

  try {
    // Expanding the same node twice — which happens constantly, because the
    // canvas re-expands on every click — should not re-read the chain.
    const graph = await cached(`graph:${chainId}:${seed}`, 4000, () =>
      buildGraph(chain, seed)
    );
    return NextResponse.json(graph, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      {
        nodes: [],
        edges: [],
        seed,
        error: e instanceof Error ? e.message : "Could not build that view.",
      },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
