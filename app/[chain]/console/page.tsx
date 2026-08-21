import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getChain, accentFor } from "@/lib/chains";
import { COMMAND_NAMES } from "@/lib/console";
import { ConsoleSurface } from "@/components/console-surface";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `Console · ${chain.prettyName}` : "Console" };
}

/**
 * The console presentation.
 *
 * A second way to read the same chain, not a second explorer: every result links
 * back into the ordinary pages. The server's only job is to hand the client the
 * chain's identity and the command list — see `lib/console.ts` for the rest.
 */
export default async function ConsolePage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  return (
    <main className="mx-auto h-full max-w-6xl px-3 py-3 sm:px-4 sm:py-4">
      <ConsoleSurface
        chainId={chain.chainId}
        prettyName={chain.prettyName}
        accent={accentFor(chain)}
        commands={COMMAND_NAMES}
      />
    </main>
  );
}
