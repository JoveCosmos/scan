import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { getChain, symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { isVoting, tallyShares } from "@/lib/proposals";
import { TallyBar } from "@/components/tally-bar";
import { StatusBadge } from "@/components/proposal-status-badge";
import { ProposalVotes } from "@/components/proposal-votes";
import { LoadingPanel } from "@/components/loading-panel";

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

/** One-line hint shown while the summary is collapsed, so the closed panel
 *  still says something about what is inside it. */
function summaryPreview(summary: string): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3.5 last:border-0 sm:grid-cols-[190px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

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
  const symbol = symbolFor(chain);

  if (!proposal) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link
          href={`/${chainId}/proposals`}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to proposals
        </Link>
        <div className="gata-panel px-6 py-14 text-center">
          <h1 className="text-lg font-semibold">Proposal not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {chain.prettyName} has no proposal #{id}.
          </p>
        </div>
      </main>
    );
  }

  const shares = tallyShares(proposal.tally);
  const voting = isVoting(proposal.status);
  const hasVotes = Number(proposal.tally.total) > 0;
  // Threshold is measured against non-abstain votes, which is how the gov
  // module decides pass/fail.
  const decisive = shares.yes + shares.no + shares.veto;
  const yesOfDecisive = decisive > 0 ? shares.yes / decisive : 0;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href={`/${chainId}/proposals`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to proposals
      </Link>

      <div className="mb-6 flex items-start gap-3">
        <span
          className="mt-1 h-11 w-1 shrink-0 rounded-full"
          style={{ background: accent, boxShadow: `0 0 16px ${accent}` }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">
              #{proposal.id}
            </span>
            <StatusBadge status={proposal.status} />
            {proposal.expedited ? (
              <span className="rounded-full bg-[var(--gata-cyan)]/12 px-2 py-0.5 text-xs font-medium text-[var(--gata-cyan)]">
                Expedited
              </span>
            ) : null}
          </div>
          <h1 className="mt-1.5 text-2xl font-semibold leading-tight tracking-tight">
            {proposal.title}
          </h1>
        </div>
      </div>

      <div className="gata-panel mb-5 p-5" style={{ ["--panel-accent" as string]: accent }}>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">
            {voting ? "Current votes" : "Final tally"}
          </h2>
          {proposal.liveTally ? (
            <span className="text-xs text-muted-foreground">live count</span>
          ) : null}
        </div>

        {hasVotes ? (
          <>
            <TallyBar tally={proposal.tally} />
            {govParams?.threshold != null ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {(yesOfDecisive * 100).toFixed(1)}% yes of decisive votes ·
                threshold {(govParams.threshold * 100).toFixed(1)}%
                {govParams.quorum != null
                  ? ` · quorum ${(govParams.quorum * 100).toFixed(1)}%`
                  : null}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No votes recorded
            {proposal.status === "PROPOSAL_STATUS_DEPOSIT_PERIOD"
              ? " - still in the deposit period."
              : "."}
          </p>
        )}
      </div>

      {proposal.summary ? (
        // A native <details>: collapsed by default, keyboard accessible, and it
        // works without JavaScript — this section sits above the streamed vote
        // list, so it should never depend on hydration to open.
        // The chevron rotation lives in globals.css; Tailwind's group-open:
        // variant generated no rule for it.
        <details className="gata-panel mb-5 sm:[&:not([open])_.summary-preview]:block">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="summary-chevron h-4 w-4 shrink-0" />
            Summary
            <span className="summary-preview ml-auto hidden truncate text-xs font-normal text-muted-foreground">
              {summaryPreview(proposal.summary)}
            </span>
          </summary>
          <div className="border-t border-border/50 px-5 py-4">
            {/* Proposer-authored text: rendered as plain text, never as HTML. */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {proposal.summary}
            </p>
          </div>
        </details>
      ) : null}

      <div className="gata-panel" style={{ ["--panel-accent" as string]: accent }}>
        <dl>
          <Row label="Status">{proposal.status.replace(/^PROPOSAL_STATUS_/, "")}</Row>
          <Row label="Submitted">{when(proposal.submitTime)}</Row>
          <Row label="Voting Period">
            {proposal.votingStartTime || proposal.votingEndTime ? (
              <span>
                {when(proposal.votingStartTime)} → {when(proposal.votingEndTime)}
              </span>
            ) : (
              "—"
            )}
          </Row>
          <Row label="Total Deposit">
            {proposal.totalDeposit.length > 0
              ? proposal.totalDeposit
                  .map(
                    (c) =>
                      `${formatToken(c.amount, chain.exponent, 2)} ${
                        c.denom === chain.denom ? symbol : c.denom
                      }`
                  )
                  .join(", ")
              : "—"}
          </Row>
          {proposal.proposer ? (
            <Row label="Proposer">
              <Link
                href={`/${chainId}/accounts/${proposal.proposer}`}
                className="font-mono text-xs text-primary hover:underline"
                title={proposal.proposer}
              >
                {truncateMiddle(proposal.proposer, 14, 8)}
              </Link>
            </Row>
          ) : null}
          {proposal.messageTypes.length > 0 ? (
            <Row label="Messages">
              <ul className="space-y-1">
                {proposal.messageTypes.map((t, i) => (
                  <li key={`${t}-${i}`} className="font-mono text-xs break-all">
                    {t}
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
          {proposal.failedReason ? (
            <Row label="Failure Reason">
              <span className="text-[var(--gata-burn)]">{proposal.failedReason}</span>
            </Row>
          ) : null}
        </dl>
      </div>

      <h2 className="mt-6 mb-3 text-sm font-medium text-muted-foreground">Votes</h2>
      {/* Streamed separately: fetching every vote is the slowest read on the
          page and the tally above does not depend on it. */}
      <Suspense
        fallback={
          <LoadingPanel
            label="Loading votes…"
            hint={
              voting
                ? undefined
                : // The gov module deletes votes once it tallies, so a finished
                  // proposal is rebuilt from tens of paged transaction reads.
                  // Saying so turns a ten-second wait into an explained one.
                  "Rebuilding this proposal's votes from transaction history - this can take a few seconds."
            }
            rows={6}
          />
        }
      >
        <ProposalVotes
          chain={chain}
          proposalId={proposal.id}
          status={proposal.status}
        />
      </Suspense>
    </main>
  );
}
