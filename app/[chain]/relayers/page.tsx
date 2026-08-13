import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChain } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { RelayerOperators } from "@/components/relayer-operators";
import { IbcRoutesTable } from "@/components/ibc-routes-table";
import { LoadingPanel } from "@/components/loading-panel";

export const revalidate = 120;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} relayers` : "Relayers" };
}

/**
 * IBC connectivity for one chain: which routes work, and who keeps them working.
 *
 * Routes are a curated set rather than every channel the chain has ever opened.
 * Chains accumulate dead channels — AtomOne carries an old Osmosis channel
 * whose light client expired long ago — and listing all of them buries the two
 * or three that actually carry traffic.
 */
export default async function RelayersPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();
  // Not offered at this chain's tier, so the route 404s rather than
  // staying reachable by URL after the tab is hidden.
  if (!policyFor(chain).relayers) notFound();

  // gno.land runs Tendermint2 with no IBC module — same condition the header
  // uses to decide whether the tab exists at all.
  if (chain.kind !== "cosmos") notFound();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-xl font-medium">Relayers</h1>

      <h2 className="mt-6 mb-3 text-sm font-medium text-muted-foreground">
        Routes
      </h2>
      <Suspense
        fallback={
          <LoadingPanel
            label="Checking routes…"
            hint="Reading light client status and pending packets on both sides."
            rows={3}
          />
        }
      >
        <IbcRoutesTable chainId={chainId} />
      </Suspense>

      <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">
        Operators
      </h2>
      <Suspense
        fallback={
          <LoadingPanel
            label="Counting relays…"
            hint="Attributing every IBC message to the operator who paid for it."
            rows={5}
          />
        }
      >
        <RelayerOperators chain={chain} />
      </Suspense>
    </main>
  );
}
