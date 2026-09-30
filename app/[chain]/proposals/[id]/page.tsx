import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChain, accentFor, chainDenoms } from "@/lib/chains";
import type { ChainConfig } from "@/lib/chains";
import { formatCoins, formatCoinsExact } from "@/lib/coin";
import { getAdapter } from "@/lib/adapter";
import { formatDate, formatDateTime, timeAgo, timeUntil, truncateMiddle } from "@/lib/format";
import { cached } from "@/lib/cache";
import { decodeMessage } from "@/lib/msg-decode";
import { govDeposits, govProposalRecord, proposalRecasts } from "@/lib/indexer-validator";
import {
  getBondedTokens,
  getDeposits,
  indexValidatorAccounts,
  isVoting,
  proposalStatusLabel,
  tallyShares,
  voteOptionLabel,
  type ProposalMessage,
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
  // Plain text for a one-line preview: Markdown marks and link targets out.
  const flat = summary
    .replace(/\\n/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
}

const when = formatDateTime;
const day = formatDate;

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

/** "Yes 60%, No 40%" for a split vote, the option alone for everyone else. */
function voteLabel(vote: { primary: string; weighted: boolean; options: { option: string; weight: number }[] }) {
  if (!vote.weighted) return voteOptionLabel(vote.primary);
  return vote.options
    .map((o) => `${voteOptionLabel(o.option)} ${(o.weight * 100).toFixed(0)}%`)
    .join(", ");
}

/** Votes shown per server page. The whole list used to ship at once: 3,538
 *  votes made a 2.5 MB page. */
const VOTE_PAGE = 100;

/**
 * A proposal message as labelled rows. The proposal-only types - spending the
 * community pool, scheduling an upgrade, legacy content - are read here; the
 * rest go through the shared message decoder.
 */
function messageRows(
  chainId: string,
  message: ProposalMessage,
  coins: (c: { denom: string; amount: string }[]) => string
): DetailRow[] {
  const raw = message.raw as Record<string, unknown>;
  const name = message.typeUrl.split(".").pop() ?? "";
  const content = (raw.content ?? {}) as Record<string, unknown>;
  const src = /MsgExecLegacyContent$/.test(message.typeUrl) ? content : raw;
  const rows: DetailRow[] = [];

  const recipient = typeof src.recipient === "string" ? src.recipient : null;
  const amount = Array.isArray(src.amount) ? (src.amount as { denom: string; amount: string }[]) : null;
  const plan = (src.plan ?? null) as { name?: string; height?: string; info?: string } | null;

  if (recipient) rows.push({ label: "Recipient", value: recipient, mono: true, address: recipient });
  if (amount && amount.length > 0) rows.push({ label: "Amount", value: coins(amount), mono: true });
  if (plan) {
    if (plan.name) rows.push({ label: "Upgrade", value: plan.name, mono: true });
    if (plan.height && plan.height !== "0") {
      rows.push({
        label: "Height",
        value: Number(plan.height).toLocaleString(),
        mono: true,
        href: `/${chainId}/blocks/${plan.height}`,
      });
    }
  }
  if (rows.length > 0) return rows;
  if (/MsgExecLegacyContent$/.test(message.typeUrl) && typeof content.title === "string") {
    return [{ label: "Content", value: String(content["@type"] ?? ""), mono: true }];
  }
  if (name === "MsgUpdateParams" && raw.params) {
    return [{ label: "Params", value: JSON.stringify(raw.params, null, 2), mono: true }];
  }
  return decodeMessage(chainId, message.typeUrl, raw, { formatCoins: coins }).rows.map((r) => ({
    label: r.label,
    value: r.value,
    mono: r.mono,
    href: r.href,
    address: r.address,
  }));
}

/**
 * Who voted, and how - or which validators did not.
 *
 * Streamed separately: fetching every vote is the slowest read on the page and
 * the tally above does not depend on it. Filtered and paged on the server so
 * the page carries one page of votes, not all of them. Validators sort first:
 * they are the votes people come to check.
 */
async function VotesDeck({
  chain,
  proposal,
  accent,
  view,
  voterQuery,
  page,
}: {
  chain: ChainConfig;
  proposal: ProposalSummary;
  accent: string;
  view: "votes" | "novote";
  voterQuery: string;
  page: number;
}) {
  const adapter = getAdapter(chain);
  const [{ votes, byOption, truncated, failed }, validators, recasts] = await Promise.all([
    adapter.getProposalVotes(proposal.id, {
      start: proposal.votingStartTime,
      end: proposal.votingEndTime,
    }),
    adapter.getValidators().catch(() => []),
    // Earlier choices of voters who changed their vote, from the index.
    proposalRecasts(chain.chainId, proposal.id, proposal.votingStartTime).catch(() => null),
  ]);

  const chainId = chain.chainId;
  const base = `/${chainId}/proposals/${proposal.id}`;
  const byAccount = indexValidatorAccounts(validators, chain.bech32Prefix);
  const powerOf = new Map(validators.map((v) => [v.operatorAddress, v.votingPower]));
  const tallied = Number(proposal.tally.total) > 0;
  // Votes that could not be read, beside a tally that says there are some,
  // are unknown, not absent.
  const unreadable = failed || (votes.length === 0 && tallied);
  const complete = !unreadable && !truncated;

  const voted = new Set(votes.map((v) => v.voter));
  const didNotVote = complete
    ? validators
        .map((v) => ({ v, account: [...byAccount.entries()].find(([, x]) => x.operatorAddress === v.operatorAddress)?.[0] }))
        .filter(({ account }) => account && !voted.has(account))
        .map(({ v }) => v)
    : null;

  const tabs = (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <a
        href={`${base}`}
        aria-current={view === "votes" ? "page" : undefined}
        className={`rounded-md px-2 py-0.5 ${view === "votes" ? "bg-[var(--gata-card-hi)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Votes <span className="font-mono text-[11px] text-muted-foreground">{unreadable ? "N/A" : votes.length.toLocaleString()}</span>
      </a>
      <a
        href={`${base}?view=novote`}
        aria-current={view === "novote" ? "page" : undefined}
        className={`rounded-md px-2 py-0.5 ${view === "novote" ? "bg-[var(--gata-card-hi)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Validators not voted{" "}
        <span className="font-mono text-[11px] text-muted-foreground">{didNotVote ? didNotVote.length : "N/A"}</span>
      </a>
      {view === "votes" ? (
        <form method="get" action={base} className="ml-auto">
          <input
            name="voter"
            defaultValue={voterQuery}
            placeholder="Filter voter or validator…"
            aria-label="Filter voter or validator"
            className="h-7 w-52 rounded-md border border-border bg-[var(--gata-card)] px-2 text-[12px] outline-none focus:border-[var(--gata-border-hi)]"
          />
        </form>
      ) : null}
    </div>
  );

  if (view === "novote") {
    const rows: DeckRow[] = (didNotVote ?? [])
      .sort((a, b) => (b.votingPower ?? 0) - (a.votingPower ?? 0))
      .map((v) => ({
        key: v.operatorAddress,
        cells: [
          { v: v.moniker, href: `/${chainId}/validators/${v.operatorAddress}` },
          {
            v: v.votingPower != null ? `${(v.votingPower * 100).toFixed(2)}%` : "-",
            mono: true,
            align: "right",
          },
        ],
        detail: {
          title: v.moniker,
          rows: [],
          action: { label: "Validator", href: `/${chainId}/validators/${v.operatorAddress}` },
        },
      }));
    return (
      <RowDeck
        columns={[{ label: "Validator" }, { label: "Power", align: "right", width: "8rem" }]}
        rows={rows}
        accent={accent}
        toolbar={tabs}
        empty={didNotVote ? "Every validator voted" : "N/A"}
      />
    );
  }

  const q = voterQuery.trim().toLowerCase();
  const all = votes
    .map((vote) => ({ vote, validator: byAccount.get(vote.voter) ?? null }))
    .filter(
      ({ vote, validator }) =>
        !q ||
        vote.voter.toLowerCase().includes(q) ||
        (validator?.moniker.toLowerCase().includes(q) ?? false)
    )
    .sort(
      (a, b) =>
        Number(!!b.validator) - Number(!!a.validator) ||
        (powerOf.get(b.validator?.operatorAddress ?? "") ?? 0) -
          (powerOf.get(a.validator?.operatorAddress ?? "") ?? 0)
    );
  const pages = Math.max(1, Math.ceil(all.length / VOTE_PAGE));
  const current = Math.min(Math.max(1, page), pages);
  const shown = all.slice((current - 1) * VOTE_PAGE, current * VOTE_PAGE);

  const columns: DeckColumn[] = [
    { label: "Voter" },
    { label: "Vote", width: "22%" },
    { label: "Power", align: "right", width: "7rem", phoneHide: true },
    { label: "When", align: "right", width: "9rem", optional: true },
    { label: "Tx", width: "9rem", optional: true },
  ];

  const rows: DeckRow[] = shown.map(({ vote, validator }) => {
    const power = validator ? powerOf.get(validator.operatorAddress) : undefined;
    const target = validator
      ? `/${chainId}/validators/${validator.operatorAddress}`
      : `/${chainId}/accounts/${vote.voter}`;
    return {
      key: vote.voter,
      cells: [
        validator
          ? { v: validator.moniker, href: target }
          : { v: truncateMiddle(vote.voter, 12, 6), address: vote.voter, mono: true },
        {
          v: recasts?.get(vote.voter)
            ? `${voteLabel(vote)}, was ${recasts.get(vote.voter)!.map(voteOptionLabel).join(", ")}`
            : voteLabel(vote),
          tone: vote.weighted ? undefined : VOTE_TONE[vote.primary],
          dim: vote.primary === "VOTE_OPTION_ABSTAIN",
        },
        {
          v: power != null ? `${(power * 100).toFixed(2)}%` : "-",
          mono: true,
          align: "right",
          dim: power == null,
        },
        { v: vote.time ? formatDate(vote.time) : "-", mono: true, dim: true, align: "right" },
        vote.txHash
          ? {
              v: truncateMiddle(vote.txHash, 6, 4),
              mono: true,
              href: `/${chainId}/txs/${encodeURIComponent(vote.txHash)}`,
            }
          : { v: "-", dim: true },
      ],
      detail: { title: validator?.moniker ?? vote.voter, rows: [], action: { label: "Voter", href: target } },
    };
  });

  const counts = Object.entries(byOption).sort((a, b) => b[1] - a[1]);
  const qs = (n: number) =>
    `${base}?${new URLSearchParams({ ...(voterQuery ? { voter: voterQuery } : {}), vpage: String(n) })}`;
  const pager =
    pages > 1 ? (
      <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        {current > 1 ? <a href={qs(current - 1)} className="hover:text-foreground">‹</a> : null}
        <span>
          {((current - 1) * VOTE_PAGE + 1).toLocaleString()}–
          {Math.min(current * VOTE_PAGE, all.length).toLocaleString()} of {all.length.toLocaleString()}
        </span>
        {current < pages ? <a href={qs(current + 1)} className="hover:text-foreground">›</a> : null}
      </span>
    ) : null;

  return (
    <RowDeck
      columns={columns}
      rows={rows}
      accent={accent}
      toolbar={
        <div className="flex flex-col gap-1.5">
          {tabs}
          {rows.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {counts.map(([option, count]) => (
                <span key={option} className="font-mono tabular-nums">
                  {voteOptionLabel(option)} {count.toLocaleString()}
                </span>
              ))}
              {truncated ? <span>capped</span> : null}
              {pager}
            </div>
          ) : null}
        </div>
      }
      empty={
        unreadable
          ? "N/A"
          : q
            ? `No voter matches "${voterQuery}".`
            : isVoting(proposal.status)
              ? "No votes yet"
              : "No votes"
      }
    />
  );
}

/**
 * One proposal, in one screen: bricks for the tally, turnout, dates, deposit,
 * proposer and messages, over the votes.
 */
export default async function ProposalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string; id: string }>;
  searchParams: Promise<{ view?: string; voter?: string; vpage?: string }>;
}) {
  const { chain: chainId, id } = await params;
  const sp = await searchParams;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const adapter = getAdapter(chain);
  if (!adapter.capabilities.governance) notFound();
  if (!/^\d+$/.test(id)) notFound();

  const [proposal, govParams, validators] = await Promise.all([
    adapter.getProposal(id),
    adapter.getGovParams(),
    adapter.getValidators().catch(() => []),
  ]);
  const accent = accentFor(chain);
  if (!proposal) notFound();

  const voting = isVoting(proposal.status);
  const depositing = proposal.status === "PROPOSAL_STATUS_DEPOSIT_PERIOD";
  const [bonded, liveDeposits, record, indexedDeposits] = await Promise.all([
    voting ? cached(`bonded:${chain.chainId}`, 60_000, () => getBondedTokens(chain)) : null,
    voting || depositing ? getDeposits(chain, proposal.id) : null,
    // The index's record of the proposal's life: submit tx, proposer, outcome.
    govProposalRecord(chain.chainId, proposal.id).catch(() => null),
    // After the deposit period the chain forgets its depositors; the index doesn't.
    voting || depositing
      ? null
      : govDeposits(chain.chainId, proposal.id, proposal.submitTime).catch(() => null),
  ]);
  const deposits = liveDeposits ?? indexedDeposits;
  const proposer = proposal.proposer ?? record?.proposer ?? null;

  const denoms = chainDenoms(chain);
  const exact = (c: { denom: string; amount: string }[]) => formatCoinsExact(c, denoms);
  const shares = tallyShares(proposal.tally);
  const hasVotes = Number(proposal.tally.total) > 0;
  // Threshold is measured against non-abstain votes, which is how the gov
  // module decides pass/fail.
  const decisive = shares.yes + shares.no + shares.veto;
  const yesOfDecisive = decisive > 0 ? shares.yes / decisive : 0;
  const vetoOfAll = shares.veto;
  const turnout =
    voting && bonded && Number(bonded) > 0 ? Number(proposal.tally.total) / Number(bonded) : null;

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
        ...(govParams?.vetoThreshold != null && proposal.tally.veto !== null
          ? [{ label: "Veto threshold", value: pct(govParams.vetoThreshold), mono: true }]
          : []),
        ...(govParams?.quorum != null
          ? [{ label: "Quorum", value: pct(govParams.quorum), mono: true }]
          : []),
      ]
    : [{ label: "Tally", value: "N/A" }];

  const proposerValidator = proposer
    ? indexValidatorAccounts(validators, chain.bech32Prefix).get(proposer)
    : undefined;

  const vetoBad =
    govParams?.vetoThreshold != null && proposal.tally.veto !== null && vetoOfAll > govParams.vetoThreshold;

  const facts: BrickSpec[] = [
    {
      key: "tally",
      label: voting ? "Current votes" : "Final tally",
      value: hasVotes ? pct(yesOfDecisive) : "-",
      sub: hasVotes
        ? `yes of decisive${
            govParams?.threshold != null ? `, needs ${pct(govParams.threshold, 0)}` : ""
          }${vetoBad ? `, veto ${pct(vetoOfAll)}` : ""}`
        : "N/A",
      tone: vetoBad ? ("bad" as const) : undefined,
      lead: true,
      count: tallyRows.length,
      rows: tallyRows,
    },
    ...(turnout !== null
      ? [
          {
            key: "turnout",
            label: "Turnout",
            value: pct(turnout),
            sub: govParams?.quorum != null ? `quorum ${pct(govParams.quorum, 0)}` : "of bonded",
            tone:
              govParams?.quorum != null && turnout < govParams.quorum ? ("bad" as const) : ("ok" as const),
          },
        ]
      : []),
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
        { label: "Status", value: proposalStatusLabel(proposal.status) },
        { label: "Expedited", value: proposal.expedited ? "Yes" : "No" },
        { label: "Submitted", value: when(proposal.submitTime) },
        ...(record?.submitTx
          ? [
              {
                label: "Submit tx",
                value: truncateMiddle(record.submitTx, 10, 6),
                mono: true,
                href: `/${chainId}/txs/${record.submitTx}`,
              },
            ]
          : []),
        ...(record?.outcome
          ? [
              {
                label: "Outcome",
                value: `${record.outcome.charAt(0).toUpperCase()}${record.outcome.slice(1)}${
                  record.outcomeTime ? `, ${when(record.outcomeTime)}` : ""
                }`,
              },
            ]
          : []),
        ...(record?.outcomeHeight
          ? [
              {
                label: "Outcome block",
                value: record.outcomeHeight.toLocaleString(),
                mono: true,
                href: `/${chainId}/blocks/${record.outcomeHeight}`,
              },
            ]
          : []),
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
            ? `ends ${timeUntil(proposal.votingEndTime) ?? "-"}`
            : `opened ${day(proposal.votingStartTime)}`
          : "never opened",
      rows: [
        { label: "Voting opens", value: when(proposal.votingStartTime) },
        { label: "Voting closes", value: when(proposal.votingEndTime) },
        { label: "Deposit ends", value: when(proposal.depositEndTime) },
        { label: "Submitted", value: when(proposal.submitTime) },
      ],
    },
    {
      key: "deposit",
      label: "Deposit",
      value: formatCoins(proposal.totalDeposit, denoms, 2),
      sub: deposits
        ? `${deposits.length} depositor${deposits.length === 1 ? "" : "s"}`
        : depositing
          ? `ends ${timeUntil(proposal.depositEndTime) ?? "-"}`
          : "total deposit",
      count: deposits?.length,
      rows: [
        { label: "Total", value: exact(proposal.totalDeposit), mono: true },
        { label: "Deposit ends", value: when(proposal.depositEndTime) },
        ...(deposits
          ? deposits.map((d) => ({
              label: exact(d.amount),
              value: d.depositor,
              mono: true,
              address: d.depositor,
            }))
          : [{ label: "Depositors", value: "N/A" }]),
      ],
    },
    ...(proposer
      ? [
          {
            key: "proposer",
            label: "Proposer",
            value: proposerValidator?.moniker ?? truncateMiddle(proposer, 10, 6),
            sub: proposerValidator ? "validator" : "account",
            text: !!proposerValidator,
            href: proposerValidator
              ? `/${chainId}/validators/${proposerValidator.operatorAddress}`
              : `/${chainId}/accounts/${proposer}`,
          },
        ]
      : []),
    ...(proposal.messages.length > 0
      ? [
          {
            key: "messages",
            label: "Messages",
            value: proposal.messages[0].label,
            text: true,
            sub: `${proposal.messages.length} message${proposal.messages.length === 1 ? "" : "s"}`,
            rows: proposal.messages.flatMap((m, i) => [
              { label: `Message ${i + 1}`, value: m.label },
              ...messageRows(chainId, m, exact),
            ]),
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
            sub: "text",
            body: proposal.summary,
          },
        ]
      : []),
  ];

  const view = sp.view === "novote" ? "novote" : "votes";
  const page = Number(sp.vpage) || 1;

  return (
    <PageFrame
      title={proposal.title || `Proposal #${proposal.id}`}
      sub={`#${proposal.id}`}
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
      {/* Phones scroll the page body and give the list a fixed height; from
          lg the list takes the rest of the frame and only it scrolls. */}
      <div className="flex h-full flex-col gap-3 overflow-y-auto lg:overflow-hidden">
        <BrickBoard bricks={facts} accent={accent} className="shrink-0" />

        {hasVotes ? (
          <div className="shrink-0">
            <TallyBar tally={proposal.tally} showLegend={false} />
          </div>
        ) : null}

        <div className="h-[32rem] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
          <Suspense fallback={<LoadingPanel label="Loading votes…" rows={4} />}>
            <VotesDeck
              chain={chain}
              proposal={proposal}
              accent={accent}
              view={view}
              voterQuery={sp.voter ?? ""}
              page={page}
            />
          </Suspense>
        </div>
      </div>
    </PageFrame>
  );
}
