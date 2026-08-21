import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getChain, accentFor } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
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

/** The restore sequence, with the double-signing guard kept where it belongs. */
function restoreScript(url: string, daemon: string, home: string): string {
  return [
    `sudo systemctl stop ${daemon}`,
    ``,
    `# Keep the signing state — this is the step that prevents double-signing.`,
    `cp ${home}/data/priv_validator_state.json ${home}/priv_validator_state.json.backup`,
    ``,
    `rm -rf ${home}/data`,
    `curl -o - -L ${url} | lz4 -dc - | tar -xf - -C ${home}`,
    ``,
    `mv ${home}/priv_validator_state.json.backup ${home}/data/priv_validator_state.json`,
    `sudo systemctl start ${daemon}`,
  ].join("\n");
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
  const services = policyFor(chain).fullNode ? servicesFor(chain.chainId) : null;
  const snapshot = services?.snapshot ?? null;

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
          script:
            services?.daemon && services?.home
              ? restoreScript(snapshot.url, services.daemon, services.home)
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
