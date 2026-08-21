import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getChain, accentFor } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
import { getSnapshotIndex } from "@/lib/snapshots";
import { getStateSync, getNodeIds } from "@/lib/statesync";
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
 * The restore sequence, with the double-signing guard kept where it belongs.
 *
 * We publish zstd, not lz4 — the previous `lz4 -dc` would have failed on every
 * archive we have ever served. The archive also ships a ZEROED
 * priv_validator_state.json, so extraction overwrites the operator's own copy:
 * the backup line is not optional advice, it is the difference between a
 * restored node and a slashed one.
 */
function restoreScript(
  url: string,
  daemon: string,
  home: string,
  dataDir: string,
  stateFile: string,
  sha256?: string
): string {
  const file = url.split("/").pop() ?? "snapshot.tar.zst";

  // The signing state only needs saving when it lives INSIDE the directory the
  // archive replaces. On cosmos it does, and skipping the backup is how you
  // double-sign. On gno it sits in secrets/, which the archive never touches, so
  // the backup would be theatre - and telling someone to protect a file that is
  // not at risk teaches them the step is optional.
  const stateAtRisk = stateFile.startsWith(`${dataDir}/`);

  const lines = [`sudo systemctl stop ${daemon}`, ``];
  if (stateAtRisk) {
    lines.push(
      `# Keep the signing state — this is the step that prevents double-signing.`,
      `cp ${home}/${stateFile} ${home}/priv_validator_state.json.backup`,
      ``
    );
  }
  lines.push(`curl -O -L ${url}`);
  if (sha256) lines.push(`echo "${sha256}  ${file}" | sha256sum -c   # must print: OK`);
  lines.push(
    ``,
    `rm -rf ${home}/${dataDir}`,
    `tar --use-compress-program=unzstd -xf ${file} -C ${home}`,
    ``
  );
  if (stateAtRisk) {
    lines.push(`mv ${home}/priv_validator_state.json.backup ${home}/${stateFile}`);
  } else {
    lines.push(`# ${stateFile} is outside ${dataDir}/ and is left untouched.`);
  }
  lines.push(`sudo systemctl start ${daemon}`);
  return lines.join("\n");
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

  const wantsStateSync = services?.stateSync?.enabled ?? true;
  const [stateSync, nodeIds] = await Promise.all([
    wantsStateSync
      ? getStateSync(chain, rpcServers, services?.stateSync?.trustPeriod).catch(
          () => null
        )
      : null,
    // The node id is half of a peer address and the only half we can state as
    // fact; it is worth showing even where no P2P address is published.
    getNodeIds(rpcServers).catch(() => new Map<string, string>()),
  ]);

  const spec: InfraSpec = {
    endpoints: (services?.endpoints ?? []).map((e) => ({
      label: e.label,
      url: e.url,
      kind: e.kind,
      note: e.note,
    })),

    snapshot: snapshot
      ? {
          live: snapshot.status === "live",
          url: snapshot.url,
          headline: snapshot.size ?? (snapshot.status === "live" ? "ready" : "soon"),
          sub:
            snapshot.status === "live"
              ? (snapshot.pruning ?? "available")
              : "coming soon",
          // Only offer commands for a snapshot that actually exists: a paste-able
          // recipe pointing at a file we have not published deletes a data
          // directory and then fails to refill it.
          script:
            snapshot.url && snapshot.status === "live" && services?.daemon && services?.home
              ? restoreScript(
                  snapshot.url,
                  services.daemon,
                  services.home,
                  services.dataDir,
                  services.stateFile,
                  snapshot.sha256
                )
              : null,
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
            ...(services?.daemon
              ? [{ label: "Daemon", value: services.daemon, mono: true }]
              : []),
            ...(services?.home ? [{ label: "Home", value: services.home, mono: true }] : []),
            ...(snapshot.note ? [{ label: "Note", value: snapshot.note }] : []),
          ],
        }
      : null,

    stateSync: stateSync
      ? {
          trustHeight: stateSync.trustHeight,
          trustHash: stateSync.trustHash,
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
            {
              label: "Height",
              value:
                "Deliberately behind the head. State sync verifies against a header the servers must still be able to serve, and a height near the tip can be reorganised out from under it.",
            },
            {
              label: "Freshness",
              value:
                "Recomputed on every load. A trust hash written into a config file is wrong within days, and a wrong one fails the sync with an error that reads like a network problem.",
            },
          ],
        }
      : null,

    seeds: {
      entries: services?.seeds ?? [],
      key: "seeds",
      note: "Seeds are dialled only to discover other nodes, then dropped. Put them in the `seeds` line of config.toml, not in `persistent_peers`.",
    },

    peers: {
      entries: [...(services?.peers ?? [])],
      key: "persistent_peers",
      note:
        nodeIds.size > 0
          ? `Persistent peers are held open rather than rotated. Our own node ${
              nodeIds.size === 1 ? "id is" : "ids are"
            } ${[...nodeIds.values()].join(", ")} — the P2P host and port are not discoverable from the RPC, so they are only listed here where we publish them.`
          : "Persistent peers are held open rather than rotated, so use them for nodes you want a lasting connection to.",
    },

    indexer: {
      indexed: chain.indexed,
      rows: chain.indexed
        ? [
            { label: "Status", value: "This chain is indexed." },
            {
              label: "Provides",
              value:
                "Account and proposal history, validator commission, jail and slash records, proposer counts, stake movement and relayer rankings.",
            },
            {
              label: "Why",
              value:
                "A node answers about now. Anything historical — who voted, what a validator earned, how stake moved — needs a record kept alongside it.",
            },
            {
              label: "Fallback",
              value:
                "Where the index cannot answer, the page shows nothing rather than a wrong zero.",
            },
          ]
        : [
            { label: "Status", value: "This chain is not indexed." },
            {
              label: "Reads",
              value: "Everything comes live from the chain's own endpoints.",
            },
            {
              label: "Effect",
              value:
                "Sections that need history — vote records, commission earned, slash history, relayer rankings — are absent rather than empty.",
            },
          ],
    },
  };

  return (
    <PageFrame title="Infrastructure" sub={chain.prettyName} accent={accent}>
      <InfraBoard chainId={chain.chainId} accent={accent} spec={spec} />
    </PageFrame>
  );
}
