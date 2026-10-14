import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { getAdapter } from "@/lib/adapter";
import { cached, withinBudget } from "@/lib/cache";
import { indexedProposals } from "@/lib/indexer-validator";
import {
  getAllProposals,
  getLiveTally,
  indexValidatorAccounts,
  isVoting,
  outcomeLabel,
  proposalStatusLabel,
  proposalTypeLabel,
  tallyShares,
} from "@/lib/proposals";
import { formatDate, timeUntil, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { GovernanceSwitch } from "@/components/governance-switch";
import { GovdaoList } from "./govdao";
import { SectionUnavailable } from "@/components/section-unavailable";
import { RowDeck, type DeckRow } from "@/components/row-deck";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} proposals` : "Proposals" };
}

function toneOf(status: string): "ok" | "bad" | undefined {
  if (status.includes("PASSED")) return "ok";
  if (status.includes("REJECTED") || status.includes("FAILED")) return "bad";
  return undefined;
}

/**
 * Every proposal, as a list: number, title, what it does, where it stands,
 * and who proposed it. Each row links straight to its proposal, and a
 * validator's proposal carries the validator's name.
 */
export default async function ProposalsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();
  // gno.land: governance is the GovDAO realm.
  if (chain.kind === "gno") return <GovdaoList chain={chain} />;
  const adapter = getAdapter(chain);
  const accent = accentFor(chain);

  if (!adapter.capabilities.governance || !policyFor(chain).proposals) {
    return (
      <SectionUnavailable
        title="Proposals"
        chainId={chain.chainId}
        chainName={chain.prettyName}
        accent={accent}
      />
    );
  }

  const [proposals, govParams, validators, indexed] = await Promise.all([
    cached(`proposals-all:${chain.chainId}`, 60_000, () => getAllProposals(chain), {
      staleMs: 10 * 60_000,
    }).catch(() => null),
    adapter.getGovParams(),
    adapter.getValidators().catch(() => []),
    // Proposals the chain no longer holds (dropped before voting) live on in
    // the index; only where the chain is indexed.
    withinBudget(indexedProposals(chain.chainId), 1500, null),
  ]);

  if (!proposals) {
    return (
      <PageFrame title="Proposals" sub={chain.prettyName} accent={accent}>
        <div className="flex h-full items-center justify-center">
          <p className="font-mono text-sm uppercase tracking-[0.14em] text-[var(--gata-faint)]">N/A</p>
        </div>
      </PageFrame>
    );
  }

  // The recorded tally is all zeros while voting is open; read the live one.
  const live = new Map(
    await Promise.all(
      proposals
        .filter((p) => isVoting(p.status))
        .map(async (p) => [p.id, await getLiveTally(chain, p.id)] as const)
    )
  );
  const byAccount = indexValidatorAccounts(validators, chain.bech32Prefix);

  const rows: DeckRow[] = proposals.map((p) => {
    const voting = isVoting(p.status);
    const tally = (voting ? live.get(p.id) : null) ?? p.tally;
    const s = tallyShares(tally);
    const decisive = s.yes + s.no + s.veto;
    const hasVotes = Number(tally.total) > 0;
    const proposerValidator = p.proposer ? byAccount.get(p.proposer) : undefined;
    const type = p.messages[0]?.label ?? "Text";
    const href = `/${chain.chainId}/proposals/${p.id}`;

    return {
      key: p.id,
      search: `${p.id} ${p.title} ${type} ${p.proposer ?? ""} ${proposerValidator?.moniker ?? ""}`,
      cells: [
        { v: `#${p.id}`, mono: true, tone: "accent", href },
        { v: p.title || `Proposal ${p.id}` },
        {
          v: p.messages.length > 1 ? `${type} +${p.messages.length - 1}` : type,
          dim: true,
        },
        { v: proposalStatusLabel(p.status), tone: toneOf(p.status) },
        {
          v: voting
            ? (timeUntil(p.votingEndTime) ?? "voting")
            : formatDate(p.votingEndTime ?? p.submitTime),
          mono: true,
          dim: !voting,
          align: "right",
        },
        {
          v: hasVotes && decisive > 0 ? `${((s.yes / decisive) * 100).toFixed(1)}%` : voting && !live.get(p.id) ? "N/A" : "-",
          mono: true,
          align: "right",
          dim: !hasVotes,
        },
        p.proposer
          ? {
              v: proposerValidator?.moniker ?? truncateMiddle(p.proposer, 10, 5),
              address: proposerValidator ? undefined : p.proposer,
              href: proposerValidator
                ? `/${chain.chainId}/validators/${proposerValidator.operatorAddress}`
                : undefined,
              mono: !proposerValidator,
            }
          : { v: "-", dim: true },
      ],
      detail: { title: `#${p.id}`, rows: [], action: { label: "Proposal", href } },
    };
  });

  const onChain = new Set(proposals.map((p) => p.id));
  const dropped = (indexed ?? []).filter((r) => !onChain.has(String(r.id)));
  for (const r of dropped) {
    const href = `/${chain.chainId}/proposals/${r.id}`;
    const type = r.messages[0] ? proposalTypeLabel(r.messages[0]) : "Text";
    const proposerValidator = r.proposer ? byAccount.get(r.proposer) : undefined;
    rows.push({
      key: String(r.id),
      search: `${r.id} ${type} ${r.proposer ?? ""} ${proposerValidator?.moniker ?? ""}`,
      cells: [
        { v: `#${r.id}`, mono: true, tone: "accent", href },
        { v: `Proposal ${r.id}`, dim: true },
        { v: r.messages.length > 1 ? `${type} +${r.messages.length - 1}` : type, dim: true },
        { v: outcomeLabel(r.outcome), dim: true },
        { v: formatDate(r.outcomeTime ?? r.submitTime), mono: true, dim: true, align: "right" },
        { v: "-", mono: true, align: "right", dim: true },
        r.proposer
          ? {
              v: proposerValidator?.moniker ?? truncateMiddle(r.proposer, 10, 5),
              address: proposerValidator ? undefined : r.proposer,
              href: proposerValidator ? `/${chain.chainId}/validators/${proposerValidator.operatorAddress}` : undefined,
              mono: !proposerValidator,
            }
          : { v: "-", dim: true },
      ],
      detail: { title: `#${r.id}`, rows: [], action: { label: "Proposal", href } },
    });
  }
  if (dropped.length > 0) rows.sort((a, b) => Number(b.key) - Number(a.key));

  const active = proposals.filter((p) => isVoting(p.status)).length;
  const pct = (v: number | null | undefined) =>
    v != null ? `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%` : null;
  const facts = [
    `${proposals.length + dropped.length} total`,
    `${active} in voting`,
    ...(pct(govParams?.quorum) ? [`quorum ${pct(govParams?.quorum)}`] : []),
    ...(pct(govParams?.threshold) ? [`threshold ${pct(govParams?.threshold)}`] : []),
    ...(pct(govParams?.vetoThreshold) ? [`veto ${pct(govParams?.vetoThreshold)}`] : []),
  ];

  return (
    <PageFrame
      title="Proposals"
      sub={facts.join(" · ")}
      accent={accent}
      actions={
        chain.governors ? (
          <GovernanceSwitch chainId={chain.chainId} current="proposals" counts={{ proposals: proposals.length }} />
        ) : undefined
      }
    >
      <RowDeck
        accent={accent}
        columns={[
          { label: "#", width: "4.5rem" },
          { label: "Title" },
          { label: "Type", width: "16%", phoneHide: true },
          { label: "Status", width: "7rem" },
          { label: "Ends", align: "right", width: "8rem", phoneHide: true },
          { label: "Yes", align: "right", width: "5rem", optional: true },
          { label: "Proposer", width: "12%", optional: true },
        ]}
        rows={rows}
        filter={{ placeholder: "Filter by number, title, type or proposer…" }}
        empty="No proposals"
      />
    </PageFrame>
  );
}
