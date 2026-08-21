import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getChain, accentFor } from "@/lib/chains";
import { CanvasSurface } from "@/components/canvas-surface";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `Canvas · ${chain.prettyName}` : "Canvas" };
}

/**
 * The canvas presentation.
 *
 * Nothing is fetched here: the graph is seeded and expanded from the client, one
 * bounded read at a time, because what gets drawn depends entirely on what the
 * reader clicks. The server's job is the chain's identity and its accent.
 */
export default async function CanvasPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  return (
    <main className="mx-auto h-full max-w-6xl px-3 py-3 sm:px-4 sm:py-4">
      <CanvasSurface
        chainId={chain.chainId}
        prettyName={chain.prettyName}
        accent={accentFor(chain)}
      />
    </main>
  );
}
