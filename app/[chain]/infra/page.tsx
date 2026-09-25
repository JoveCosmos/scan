import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getChain, accentFor } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
import { getSnapshotIndex } from "@/lib/snapshots";
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
  return { title: chain ? `Infra · ${chain.prettyName}` : "Infra" };
}

/**
 * What we run for this chain: endpoints, a snapshot, and whether we index it.
 *
 * The tab exists for every chain, including chains we run nothing for. That is
 * deliberate — "we publish no endpoints for this network" is an answer, and a
 * tab that appears and disappears per chain is worse than one that is
 * occasionally sparse.
 *
 * The endpoints and snapshot gate on whether we run a full node. The indexer
 * does not: it is a separate operational fact, and a chain can be indexed
 * without us serving its RPC.
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
  // Tier gates how much CHAIN DATA we can show; it does not describe whether we
  // publish a snapshot. juno-1 is tier "limited" for indexing reasons but we run
  // a full juno node and publish nightly from it, so a chain with a snapshotKey
  // qualifies here too.
  const configured = servicesFor(chain.chainId);
  const services =
    policyFor(chain).fullNode || configured?.snapshotKey ? configured : null;

  // Height, size, filename and checksum change every night. Read them from the
  // manifest the publisher regenerates on each run rather than from config. On a
  // failed fetch this is undefined and the panel says "planned" - better than
  // sending someone to a 404 after they have stopped their node.
  const liveSnapshot = services?.snapshotKey
    ? (await getSnapshotIndex()).get(services.snapshotKey)
    : undefined;

  const snapshot =
    services?.snapshot || liveSnapshot
      ? {
          ...(services?.snapshot ?? {}),
          status: liveSnapshot ? ("live" as const) : (services?.snapshot?.status ?? "planned"),
          url: liveSnapshot?.url ?? services?.snapshot?.url,
          height: liveSnapshot ? Number(liveSnapshot.height) : services?.snapshot?.height,
          size: liveSnapshot?.size ?? services?.snapshot?.size,
          takenAt: liveSnapshot?.modified ?? services?.snapshot?.takenAt,
          sha256: liveSnapshot?.sha256,
        }
      : null;

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
  const stateSync = wantsStateSync
    ? await getStateSync(chain, rpcServers, services?.stateSync?.trustPeriod).catch(
        () => null
      )
    : null;

  // Every archive we publish sits in /snapshots on the RPC host it came from.
  const snapshotsDir = snapshot?.url
    ? snapshot.url.slice(0, snapshot.url.lastIndexOf("/") + 1)
    : rpcServers[0] && services?.snapshotKey
      ? `${rpcServers[0].replace(/\/$/, "")}/snapshots/`
      : null;

  const spec: InfraSpec = {
    endpoints: (services?.endpoints ?? []).map((e) => ({
      label: e.label,
      url: e.url,
      kind: e.kind,
      note: e.note,
    })),

    snapshotsDir,

    snapshot: snapshot
      ? {
          live: snapshot.status === "live",
          url: snapshot.url,
          rows: [
            { label: "Status", value: snapshot.status === "live" ? "Live" : "Planned" },
            ...(snapshot.height
              ? [
                  {
                    label: "Height",
                    value: snapshot.height.toLocaleString(),
                    mono: true,
                  },
                ]
              : []),
            ...(snapshot.size ? [{ label: "Size", value: snapshot.size, mono: true }] : []),
            // A property of the file, not of the restore procedure. It used to
            // appear only inside the generated commands, so a chain without a
            // daemon and home in config published a multi-gigabyte archive with
            // no way to check what arrived.
            ...(snapshot.sha256
              ? [{ label: "SHA-256", value: snapshot.sha256, mono: true }]
              : []),
            ...(snapshot.pruning
              ? [{ label: "Pruning", value: snapshot.pruning, mono: true }]
              : []),
            ...(snapshot.takenAt
              ? [
                  {
                    label: "Taken",
                    value: new Date(snapshot.takenAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                    mono: true,
                  },
                ]
              : []),
            ...(snapshot.schedule ? [{ label: "Schedule", value: snapshot.schedule }] : []),
            ...(snapshot.version
              ? [
                  {
                    label: "Node version",
                    value: `${chain.prettyName} ${snapshot.version}`,
                    mono: true,
                  },
                ]
              : []),
          ],
        }
      : null,

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

    indexer: {
      indexed: chain.indexed,
      rows: [{ label: "Status", value: chain.indexed ? "Indexed" : "N/A" }],
    },
  };

  return (
    <PageFrame title="Infra" sub={chain.prettyName} accent={accent}>
      <InfraBoard chainId={chain.chainId} accent={accent} spec={spec} />
    </PageFrame>
  );
}
