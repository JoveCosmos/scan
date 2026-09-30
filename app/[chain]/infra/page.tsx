import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getChain, accentFor } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
import { snapshotsDirFor } from "@/lib/snapshots";
import { getStateSync } from "@/lib/statesync";
import { policyFor } from "@/lib/tiers";
import { PageFrame } from "@/components/page-frame";
import { InfraBoard, type InfraSpec } from "@/components/infra-board";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} infra` : "Infra" };
}

/**
 * What we serve for this chain: RPC, API and the snapshots folder, each with a
 * live up/down check.
 *
 * The tab exists for every chain, including chains we run nothing for: "N/A"
 * is an answer, and a tab that appears and disappears per chain is worse than
 * one that is occasionally empty.
 */
export default async function InfraPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const accent = accentFor(chain);
  // Tier gates how much chain data we show; it does not decide whether we
  // publish a snapshot. A chain with a snapshotKey qualifies either way.
  const configured = servicesFor(chain.chainId);
  const services =
    policyFor(chain).fullNode || configured?.snapshotKey ? configured : null;

  // The RPC endpoints we publish are exactly the servers a state sync should
  // point at, so there is nothing to configure — and nothing to keep in step.
  const rpcServers = (services?.endpoints ?? [])
    .filter((e) => e.kind === "rpc")
    .map((e) => e.url);

  // Off unless a chain opts in: a state-sync snippet pointing at our RPCs only works
  // if our nodes also serve snapshots, and none of them keeps a snapshot interval
  // (snapshot-interval = 0 on every node, checked 2026-09-25). Showing it anyway
  // tells an operator to sync from infrastructure that cannot serve the sync.
  const wantsStateSync = services?.stateSync?.enabled ?? false;
  const [stateSync, snapshots] = await Promise.all([
    wantsStateSync
      ? getStateSync(chain, rpcServers, services?.stateSync?.trustPeriod).catch(() => null)
      : null,
    services ? snapshotsDirFor(chain.chainId).catch(() => null) : null,
  ]);

  const spec: InfraSpec = {
    endpoints: (services?.endpoints ?? []).map((e) => ({
      label: e.label,
      url: e.url,
      kind: e.kind,
      note: e.note,
    })),

    snapshotsDir: snapshots?.dir ?? null,

    stateSync: stateSync
      ? {
          snippet: stateSync.snippet,
          rows: [
            {
              label: "Trust height",
              value: stateSync.trustHeight.toLocaleString(),
              mono: true,
            },
            { label: "Trust hash", value: stateSync.trustHash, mono: true },
            { label: "Trust period", value: stateSync.trustPeriod, mono: true },
            { label: "RPC servers", value: stateSync.rpcServers.join(", "), mono: true },
          ],
        }
      : null,
  };

  return (
    <PageFrame title="Infra" sub={chain.prettyName} accent={accent}>
      <InfraBoard chainId={chain.chainId} accent={accent} spec={spec} />
    </PageFrame>
  );
}
