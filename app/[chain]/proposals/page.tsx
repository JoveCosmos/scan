import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { getAdapter } from "@/lib/adapter";
import { isVoting } from "@/lib/proposals";
import { chainDenoms } from "@/lib/chains";
import { formatCoins } from "@/lib/coin";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { SectionUnavailable } from "@/components/section-unavailable";
import { ProposalBoard, type ProposalBrick } from "@/components/proposal-board";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `Proposals · ${chain.prettyName}` : "Proposals" };
}

function timeUntil(iso: string | null): string | null {
  if (!iso) return null;
  const delta = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(delta)) return null;
  if (delta <= 0) return "ended";
  const hours = delta / 3_600_000;
  if (hours < 1) return `${Math.ceil(delta / 60_000)}m left`;
  if (hours < 48) return `${Math.floor(hours)}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

const label = (status: string) =>
  status.replace("PROPOSAL_STATUS_", "").replaceAll("_", " ").toLowerCase();

function toneOf(status: string): "ok" | "bad" | undefined {
  if (status.includes("PASSED")) return "ok";
  if (status.includes("REJECTED") || status.includes("FAILED")) return "bad";
  return undefined;
}

export default async function ProposalsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();
  const adapter = getAdapter(chain);

  // Two different absences. No gov module is a fact about the chain and is said
  // plainly; not carrying it is ours to own, and is left at that.
  if (!adapter.capabilities.governance) {
    return (
      <SectionUnavailable
        title="Proposals"
        chainId={chain.chainId}
        chainName={chain.prettyName}
        accent={accentFor(chain)}
      />
    );
  }
  if (!policyFor(chain).proposals) {
    return (
      <SectionUnavailable
        title="Proposals"
        chainId={chain.chainId}
        chainName={chain.prettyName}
        accent={accentFor(chain)}
      />
    );
  }

  const accent = accentFor(chain);
  const denoms = chainDenoms(chain);
  const [{ proposals, total }, govParams] = await Promise.all([
    adapter.getProposals(60),
    adapter.getGovParams(),
  ]);

  const bricks: ProposalBrick[] = proposals.map((p) => {
    const voting = isVoting(p.status);
    const tallyTotal = Number(p.tally.total);
    const share = (v: string | null) =>
      v !== null && tallyTotal > 0
        ? `${((Number(v) / tallyTotal) * 100).toFixed(2)}%`
        : "—";

    return {
      id: p.id,
      title: p.title || `Proposal ${p.id}`,
      status: p.status,
      statusLabel: label(p.status),
      tone: toneOf(p.status),
      expedited: p.expedited,
      sub: voting
        ? (timeUntil(p.votingEndTime) ?? "voting")
        : `${label(p.status)} · ${timeAgo(p.submitTime)}`,
      rows: [
        { label: "Status", value: label(p.status) },
        ...(voting && p.votingEndTime
          ? [{ label: "Voting ends", value: p.votingEndTime, mono: true }]
          : []),
        { label: "Submitted", value: p.submitTime ?? "—", mono: true },
        ...(tallyTotal > 0
          ? [
              { label: "Yes", value: share(p.tally.yes), mono: true },
              { label: "No", value: share(p.tally.no), mono: true },
              { label: "Abstain", value: share(p.tally.abstain), mono: true },
              // Absent rather than zero on chains without the option.
              ...(p.tally.veto !== null
                ? [{ label: "Veto", value: share(p.tally.veto), mono: true }]
                : []),
            ]
          : [{ label: "Tally", value: "No votes recorded." }]),
        {
          label: "Deposit",
          value: formatCoins(p.totalDeposit, denoms, 2),
          mono: true,
        },
        ...(p.proposer
          ? [
              {
                label: "Proposer",
                value: truncateMiddle(p.proposer, 14, 8),
                mono: true,
              },
            ]
          : []),
        ...(p.messageTypes.length > 0
          ? [{ label: "Messages", value: p.messageTypes.join(", "), mono: true }]
          : []),
        ...(p.failedReason ? [{ label: "Failed", value: p.failedReason }] : []),
        ...(p.summary
          ? [
              {
                label: "Summary",
                // The full text lives on the detail page; this is the opening.
                value:
                  p.summary.length > 320 ? `${p.summary.slice(0, 320)}…` : p.summary,
              },
            ]
          : []),
      ],
    };
  });

  const active = proposals.filter((p) => isVoting(p.status)).length;
  const quorum =
    govParams?.quorum != null ? `${(govParams.quorum * 100).toFixed(0)}%` : null;
  const threshold =
    govParams?.threshold != null ? `${(govParams.threshold * 100).toFixed(0)}%` : null;

  return (
    <PageFrame
      title="Proposals"
      sub={`${total ?? proposals.length} total · ${active} in voting${
        quorum && threshold ? ` · quorum ${quorum} / threshold ${threshold}` : ""
      }`}
      accent={accent}
    >
      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No governance proposals found on {chain.prettyName}.
        </p>
      ) : (
        <ProposalBoard
          chainId={chain.chainId}
          accent={accent}
          proposals={bricks}
        />
      )}
    </PageFrame>
  );
}
