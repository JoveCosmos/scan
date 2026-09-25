import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChain, accentFor, chainDenoms } from "@/lib/chains";
import type { ChainConfig } from "@/lib/chains";
import { formatCoins } from "@/lib/coin";
import { getAdapter } from "@/lib/adapter";
import { timeAgo, truncateMiddle } from "@/lib/format";
import {
  indexValidatorAccounts,
  isVoting,
  proposalStatusLabel,
  tallyShares,
  voteOptionLabel,
  type ProposalSummary,
} from "@/lib/proposals";
import { TallyBar } from "@/components/tally-bar";
import { StatusBadge } from "@/components/proposal-status-badge";
import { LoadingPanel } from "@/components/loading-panel";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec, type DetailRow } from "@/components/brick-board";
import { RowDeck, type DeckColumn, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; id: string }>;
}): Promise<Metadata> {
  const { chain: chainId, id } = await params;
  const chain = getChain(chainId);
  if (!chain || !getAdapter(chain).capabilities.governance) {
    return { title: `Proposal #${id}` };
  }
  const proposal = await getAdapter(chain).getProposal(id);
  return { title: proposal ? `#${id} ${proposal.title}` : `Proposal #${id}` };
}

/** The opening of the summary, which is what the brick shows before it is opened. */
function summaryPreview(summary: string): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  return flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** A date short enough to be the one figure on a brick. */
function day(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

const pct = (value: number, decimals = 1) => `${(value * 100).toFixed(decimals)}%`;

function toneOf(status: string): "ok" | "bad" | undefined {
  if (status.includes("PASSED")) return "ok";
  if (status.includes("REJECTED") || status.includes("FAILED")) return "bad";
  return undefined;
}

const VOTE_TONE: Record<string, "ok" | "bad" | undefined> = {
  VOTE_OPTION_YES: "ok",
  VOTE_OPTION_NO: "bad",
  VOTE_OPTION_NO_WITH_VETO: "bad",
};

/** "Yes 60% · No 40%" for a split vote, the option alone for everyone else. */
function voteLabel(vote: { primary: string; weighted: boolean; options: { option: string; weight: number }[] }) {
  if (!vote.weighted) return voteOptionLabel(vote.primary);
  return vote.options
    .map((o) => `${voteOptionLabel(o.option)} ${(o.weight * 100).toFixed(0)}%`)
    .join(" · ");
}

/**
 * Who voted, and how.
 *
 * Streamed separately: fetching every vote is the slowest read on the page and
 * the tally above does not depend on it. Validators sort first — they are the
 * votes people come to check, and the deck pages rather than scrolls, so what
 * matters has to be on the first page.
 */
async function VotesDeck({
  chain,
  proposal,
  accent,
}: {
  chain: ChainConfig;
  proposal: ProposalSummary;
  accent: string;
}) {
  const adapter = getAdapter(chain);
  // Fetched together: the validator set is already cached from the validators
  // page, and the join is what puts a name on a validator's vote.
  const [{ votes, byOption, source, truncated, failed }, validators] = await Promise.all([
    adapter.getProposalVotes(proposal.id, {
      start: proposal.votingStartTime,
      end: proposal.votingEndTime,
    }),
    adapter.getValidators().catch(() => []),
  ]);

  const byAccount = indexValidatorAccounts(validators, chain.bech32Prefix);

  const columns: DeckColumn[] = [
    { label: "Voter" },
    { label: "Address", optional: true },
    { label: "Vote", width: "30%" },
  ];

  const rows: DeckRow[] = votes
    .map((vote) => ({ vote, validator: byAccount.get(vote.voter) ?? null }))
    .sort((a, b) => Number(!!b.validator) - Number(!!a.validator))
    .map(({ vote, validator }) => ({
      key: vote.voter,
      search: `${vote.voter} ${validator?.moniker ?? ""} ${validator?.operatorAddress ?? ""}`,
      cells: [
        {
          v: validator?.moniker ?? truncateMiddle(vote.voter, 14, 8),
          mono: !validator,
          tone: "accent" as const,
        },
        { v: truncateMiddle(vote.voter, 12, 8), mono: true, dim: true },
        {
          v: voteLabel(vote),
          tone: vote.weighted ? undefined : VOTE_TONE[vote.primary],
          dim: vote.primary === "VOTE_OPTION_ABSTAIN",
        },
      ],
      detail: {
        title: validator?.moniker ?? "Voter",
        sub: vote.voter,
        rows: [
          { label: "Vote", value: voteLabel(vote) },
          ...(vote.weighted
            ? vote.options.map((o) => ({
                label: voteOptionLabel(o.option),
                value: `${(o.weight * 100).toFixed(2)}% of this voter's stake`,
                mono: true,
              }))
            : []),
          { label: "Voter", value: vote.voter, mono: true },
          ...(validator
            ? [{ label: "Validator", value: validator.operatorAddress, mono: true }]
            : []),
        ],
        action: validator
          ? {
              label: "Validator",
              href: `/${chain.chainId}/validators/${validator.operatorAddress}`,
            }
          : { label: "Account", href: `/${chain.chainId}/accounts/${vote.voter}` },
      },
    }));

  const counts = Object.entries(byOption).sort((a, b) => b[1] - a[1]);

  return (
    <RowDeck
      columns={columns}
      rows={rows}
      accent={accent}
      filter={{ placeholder: "Filter by voter or validator…" }}
      toolbar={
        rows.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {counts.map(([option, count]) => (
              <span key={option} className="font-mono tabular-nums">
                {voteOptionLabel(option)} {count.toLocaleString()}
              </span>
            ))}
            <span>by voter count, not stake</span>
            {source !== "state" ? (
              // The gov module deletes votes from state when it tallies, so
              // saying where these came from is the difference between a
              // record and a reconstruction.
              <span>
                {source === "indexer"
                  ? "last vote per address, from our index of the chain's vote events"
                  : "last vote per address, rebuilt from vote transactions"}
              </span>
            ) : null}
            {truncated ? (
              <span>capped at {rows.length.toLocaleString()} — more votes exist</span>
            ) : null}
          </div>
        ) : undefined
      }
      empty={
        failed
          ? // Never claim there are no votes when we simply could not read them.
            "N/A"
          : isVoting(proposal.status)
            ? "No votes yet"
            : "No votes"
      }
    />
  );
}

/**
 * One proposal, in one screen.
 *
 * The tally, the dates, the deposit and the proposer were a panel each, stacked
 * above a vote list that started three screens down. They are bricks now, and
 * the proposal's own text — the one part that is prose rather than a figure —
 * opens in a popup instead of pushing everything below it further away.
 */
export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ chain: string; id: string }>;
}) {
  const { chain: chainId, id } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const adapter = getAdapter(chain);
  if (!adapter.capabilities.governance) notFound();
  if (!/^\d+$/.test(id)) notFound();

  const [proposal, govParams] = await Promise.all([
    adapter.getProposal(id),
    adapter.getGovParams(),
  ]);
  const accent = accentFor(chain);

  if (!proposal) {
    return (
      <PageFrame title="Proposal not found" sub={`#${id}`} accent={accent}>
        <p className="text-sm text-muted-foreground">
          {chain.prettyName} has no proposal #{id}.
        </p>
      </PageFrame>
    );
  }

  const shares = tallyShares(proposal.tally);
  const voting = isVoting(proposal.status);
  const hasVotes = Number(proposal.tally.total) > 0;
  // Threshold is measured against non-abstain votes, which is how the gov
  // module decides pass/fail.
  const decisive = shares.yes + shares.no + shares.veto;
  const yesOfDecisive = decisive > 0 ? shares.yes / decisive : 0;

  const tallyRows: DetailRow[] = hasVotes
    ? [
        { label: "Yes", value: pct(shares.yes), mono: true },
        { label: "No", value: pct(shares.no), mono: true },
        // Absent rather than zero on chains whose gov module has no veto.
        ...(proposal.tally.veto !== null
          ? [{ label: "No with veto", value: pct(shares.veto), mono: true }]
          : []),
        { label: "Abstain", value: pct(shares.abstain), mono: true },
        { label: "Yes of decisive", value: pct(yesOfDecisive), mono: true },
        ...(govParams?.threshold != null
          ? [{ label: "Threshold", value: pct(govParams.threshold), mono: true }]
          : []),
        ...(govParams?.quorum != null
          ? [{ label: "Quorum", value: pct(govParams.quorum), mono: true }]
          : []),
        {
          label: "Counted",
          value: proposal.liveTally
            ? "Live count from the gov module."
            : "The tally recorded with the proposal.",
        },
      ]
    : [
        {
          label: "Tally",
          value:
            proposal.status === "PROPOSAL_STATUS_DEPOSIT_PERIOD"
              ? "No votes recorded - still in the deposit period."
              : "No votes recorded.",
        },
      ];

  const facts: BrickSpec[] = [
    {
      key: "tally",
      label: voting ? "Current votes" : "Final tally",
      value: hasVotes ? pct(yesOfDecisive) : "—",
      sub: hasVotes
        ? `yes of decisive${
            govParams?.threshold != null ? ` · needs ${pct(govParams.threshold, 0)}` : ""
          }`
        : "no votes recorded",
      lead: true,
      count: tallyRows.length,
      rows: tallyRows,
    },
    {
      key: "status",
      label: "Status",
      value: proposalStatusLabel(proposal.status),
      sub: proposal.failedReason
        ? proposal.failedReason
        : proposal.expedited
          ? "expedited"
          : `submitted ${timeAgo(proposal.submitTime)}`,
      tone: toneOf(proposal.status),
      rows: [
        { label: "Status", value: proposal.status.replace(/^PROPOSAL_STATUS_/, "") },
        { label: "Expedited", value: proposal.expedited ? "Yes" : "No" },
        { label: "Submitted", value: when(proposal.submitTime) },
        ...(proposal.failedReason
          ? [{ label: "Failure reason", value: proposal.failedReason }]
          : []),
      ],
    },
    {
      key: "voting",
      label: voting ? "Voting ends" : "Voting period",
      value: day(proposal.votingEndTime),
      sub:
        proposal.votingStartTime || proposal.votingEndTime
          ? voting
            ? `ends ${timeAgo(proposal.votingEndTime)}`
            : `opened ${day(proposal.votingStartTime)}`
          : "never opened",
      rows: [
        { label: "Voting opens", value: when(proposal.votingStartTime) },
        { label: "Voting closes", value: when(proposal.votingEndTime) },
        { label: "Submitted", value: when(proposal.submitTime) },
      ],
    },
    {
      key: "deposit",
      label: "Deposit",
      value: formatCoins(proposal.totalDeposit, chainDenoms(chain), 2),
      sub: "total deposit",
      rows:
        proposal.totalDeposit.length > 0
          ? proposal.totalDeposit.map((coin) => ({
              label: "Deposited",
              value: formatCoins([coin], chainDenoms(chain), 6),
              mono: true,
            }))
          : undefined,
    },
    ...(proposal.proposer
      ? [
          {
            key: "proposer",
            label: "Proposer",
            value: truncateMiddle(proposal.proposer, 10, 6),
            sub: "account",
            href: `/${chainId}/accounts/${proposal.proposer}`,
          },
        ]
      : []),
    ...(proposal.messageTypes.length > 0
      ? [
          {
            key: "messages",
            label: "Messages",
            // The type URL's last segment is the message; the rest is a package
            // path that is the same on every proposal.
            value: proposal.messageTypes[0].split(".").pop() ?? proposal.messageTypes[0],
            sub: `${proposal.messageTypes.length} message${
              proposal.messageTypes.length === 1 ? "" : "s"
            }`,
            count: proposal.messageTypes.length,
            rows: proposal.messageTypes.map((type, i) => ({
              label: `Message ${i + 1}`,
              value: type,
              mono: true,
            })),
          },
        ]
      : []),
    ...(proposal.summary
      ? [
          {
            key: "summary",
            label: "Summary",
            value: summaryPreview(proposal.summary),
            text: true,
            sub: "the proposal's own text",
            body: proposal.summary,
          },
        ]
      : []),
  ];

  return (
    <PageFrame
      title={proposal.title || `Proposal #${proposal.id}`}
      sub={`#${proposal.id} · ${proposalStatusLabel(proposal.status)}`}
      accent={accent}
      actions={
        <>
          {proposal.expedited ? (
            <span className="rounded-full bg-[var(--gata-cyan)]/12 px-2 py-0.5 text-xs font-medium text-[var(--gata-cyan)]">
              Expedited
            </span>
          ) : null}
          <StatusBadge status={proposal.status} />
        </>
      }
    >
      <div className="flex h-full flex-col gap-3">
        <BrickBoard bricks={facts} accent={accent} className="shrink-0" />

        {hasVotes ? (
          // The bar still earns its place: the bricks give the decisive share
          // as a figure, and this is the only thing on the page that shows the
          // split at a glance. Without the legend, which the tally brick has.
          <div className="shrink-0">
            <TallyBar tally={proposal.tally} showLegend={false} />
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <LoadingPanel
                label="Loading votes…"
                hint={
                  voting
                    ? undefined
                    : // The gov module deletes votes once it tallies, so a
                      // finished proposal is rebuilt from tens of paged
                      // transaction reads. Saying so turns a ten-second wait
                      // into an explained one.
                      "Rebuilding this proposal's votes from transaction history - this can take a few seconds."
                }
                rows={4}
              />
            }
          >
            <VotesDeck chain={chain} proposal={proposal} accent={accent} />
          </Suspense>
        </div>
      </div>
    </PageFrame>
  );
}
