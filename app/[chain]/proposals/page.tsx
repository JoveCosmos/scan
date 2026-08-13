import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, accentFor, type ChainConfig } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { getAdapter } from "@/lib/adapter";
import { isVoting, type ProposalSummary } from "@/lib/proposals";
import { timeAgo } from "@/lib/format";
import { TallyBar } from "@/components/tally-bar";
import { StatusBadge } from "@/components/proposal-status-badge";
import { Skeleton } from "@/components/ui/skeleton";

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

function ProposalRow({
  proposal,
  chainId,
  accent,
}: {
  proposal: ProposalSummary;
  chainId: string;
  accent: string;
}) {
  const voting = isVoting(proposal.status);

  return (
    <Link
      href={`/${chainId}/proposals/${proposal.id}`}
      className="block border-b border-border/50 px-5 py-4 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              #{proposal.id}
            </span>
            {proposal.expedited ? (
              <span className="rounded-full bg-[var(--gata-cyan)]/12 px-2 py-0.5 text-[10px] font-medium text-[var(--gata-cyan)]">
                Expedited
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate font-medium" title={proposal.title}>
            {proposal.title}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {voting
              ? (timeUntil(proposal.votingEndTime) ?? "voting")
              : `submitted ${timeAgo(proposal.submitTime)}`}
          </p>
        </div>
        <StatusBadge status={proposal.status} />
      </div>

      {Number(proposal.tally.total) > 0 ? (
        <div className="mt-3" style={{ ["--panel-accent" as string]: accent }}>
          <TallyBar tally={proposal.tally} showLegend={false} />
        </div>
      ) : null}
    </Link>
  );
}

async function ProposalsContent({ chain }: { chain: ChainConfig }) {
  const adapter = getAdapter(chain);
  const [{ proposals, total }, params] = await Promise.all([
    adapter.getProposals(30),
    adapter.getGovParams(),
  ]);
  const accent = accentFor(chain);

  if (proposals.length === 0) {
    return (
      <div className="gata-panel px-6 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No governance proposals found on {chain.prettyName}.
        </p>
      </div>
    );
  }

  const active = proposals.filter((p) => isVoting(p.status)).length;

  return (
    <>
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div
          className="gata-panel gata-rise p-5"
          style={{ ["--panel-accent" as string]: accent }}
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Total Proposals
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold leading-none">
            {total ?? proposals.length}
          </p>
        </div>
        <div
          className="gata-panel gata-rise p-5"
          style={{
            ["--panel-accent" as string]: accent,
            animationDelay: "60ms",
          }}
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            In Voting
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold leading-none">
            {active}
          </p>
        </div>
        <div
          className="gata-panel gata-rise p-5"
          style={{
            ["--panel-accent" as string]: accent,
            animationDelay: "120ms",
          }}
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Quorum / Threshold
          </p>
          <p className="mt-2 font-mono text-2xl font-semibold leading-none">
            {params?.quorum != null ? `${(params.quorum * 100).toFixed(1)}%` : "—"}
            <span className="text-muted-foreground"> / </span>
            {params?.threshold != null
              ? `${(params.threshold * 100).toFixed(1)}%`
              : "—"}
          </p>
        </div>
      </div>

      <div className="gata-panel">
        {proposals.map((p) => (
          <ProposalRow
            key={p.id}
            proposal={p}
            chainId={chain.chainId}
            accent={accent}
          />
        ))}
      </div>
    </>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[420px] rounded-xl" />
    </div>
  );
}

export default async function ProposalsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();
  // Not offered at this chain's tier, so the route 404s rather than
  // staying reachable by URL after the tab is hidden.
  if (!policyFor(chain).proposals) notFound();

  // Chains without a gov module have no proposals route at all.
  if (!getAdapter(chain).capabilities.governance) notFound();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Proposals</h1>
        <p className="text-sm text-muted-foreground">
          Governance on {chain.prettyName}
        </p>
      </div>

      <Suspense fallback={<ListSkeleton />}>
        <ProposalsContent chain={chain} />
      </Suspense>
    </main>
  );
}
