import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { RelayerOperators } from "@/components/relayer-operators";
import { IbcRoutesTable } from "@/components/ibc-routes-table";
import { LoadingPanel } from "@/components/loading-panel";
import { PageFrame } from "@/components/page-frame";
import { SectionUnavailable } from "@/components/section-unavailable";
import { SectionTabs } from "@/components/section-tabs";

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
  // gno.land runs Tendermint2 and has no IBC module at all, which is a fact
  // about the chain rather than a choice of ours.
  if (chain.kind !== "cosmos") {
    return (
      <SectionUnavailable
        title="Relayers"
        chainId={chain.chainId}
        chainName={chain.prettyName}
        accent={accentFor(chain)}
        reason={`${chain.prettyName} runs Tendermint2 and has no IBC module, so it has no channels to relay and no relayers to rank.`}
      />
    );
  }
  if (!policyFor(chain).relayers) {
    return (
      <SectionUnavailable
        title="Relayers"
        chainId={chain.chainId}
        chainName={chain.prettyName}
        accent={accentFor(chain)}
      />
    );
  }

  return (
    <PageFrame title="Relayers" sub={chain.prettyName} accent={accentFor(chain)}>
      {/* Routes and operators take turns rather than stack: on a fixed-height
          page the second heading would sit below the fold. */}
      <SectionTabs
        sections={[
          {
            key: "routes",
            label: "Routes",
            content: (
              <div className="h-full overflow-y-auto">
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
              </div>
            ),
          },
          {
            key: "operators",
            label: "Operators",
            content: (
              <div className="h-full overflow-y-auto">
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
              </div>
            ),
          },
        ]}
      />
    </PageFrame>
  );
}
