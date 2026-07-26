import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { ChainConfig } from "@/lib/chains";
import { accentFor } from "@/lib/chains";
import { gnoValidatorDetail } from "@/lib/gno";
import { getValoper } from "@/lib/gno-valopers";
import { truncateMiddle } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";
import { Skeleton } from "@/components/ui/skeleton";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3.5 last:border-0 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function StatPanel({
  label,
  value,
  sub,
  accent,
  index,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  index: number;
}) {
  return (
    <div
      className="gata-panel gata-rise p-5"
      style={{
        ["--panel-accent" as string]: accent,
        animationDelay: `${index * 60}ms`,
      }}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold leading-none">{value}</p>
      {sub ? <p className="mt-2 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/**
 * The valopers realm read can require building a signing/operator index across
 * ~95 realm calls on a cold cache, so it streams in separately rather than
 * holding up the consensus-side facts.
 */
async function ValoperProfilePanel({
  chain,
  address,
  accent,
}: {
  chain: ChainConfig;
  address: string;
  accent: string;
}) {
  const profile = await getValoper(chain, address);

  if (!profile) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          This validator has not registered a profile in the{" "}
          <span className="font-mono text-xs">gno.land/r/gnops/valopers</span> realm.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="gata-panel mb-5" style={{ ["--panel-accent" as string]: accent }}>
        <dl>
          <Row label="Operator Address">
            <div className="flex items-start gap-2">
              <span className="min-w-0 break-all font-mono text-xs">
                {profile.operatorAddress}
              </span>
              <CopyButton value={profile.operatorAddress} label="operator address" />
            </div>
          </Row>
          {profile.signingAddress ? (
            <Row label="Signing Address">
              <span className="break-all font-mono text-xs">
                {profile.signingAddress}
              </span>
            </Row>
          ) : null}
          {profile.signingPubKey ? (
            <Row label="Signing PubKey">
              <span className="break-all font-mono text-xs text-muted-foreground">
                {profile.signingPubKey}
              </span>
            </Row>
          ) : null}
          {profile.serverType ? (
            <Row label="Server Type">
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs">
                {profile.serverType}
              </span>
            </Row>
          ) : null}
          {profile.profilePath ? (
            <Row label="Realm Profile">
              <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                {profile.profilePath}
              </span>
            </Row>
          ) : null}
        </dl>
      </div>

      {profile.description ? (
        <>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Validator profile
          </h2>
          <div className="gata-panel px-5 py-4">
            {/* Validator-authored content: rendered as plain text, never as HTML. */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {profile.description}
            </p>
          </div>
        </>
      ) : null}
    </>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-[220px] rounded-xl" />
      <Skeleton className="h-[160px] rounded-xl" />
    </div>
  );
}

export async function GnoValidatorDetail({
  chain,
  address,
}: {
  chain: ChainConfig;
  address: string;
}) {
  const accent = accentFor(chain);
  const consensus = await gnoValidatorDetail(chain, address);

  const active = consensus?.status === "ACTIVE";

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href={`/${chain.chainId}/validators`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to validators
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="h-11 w-1 shrink-0 rounded-full"
            style={{ background: accent, boxShadow: `0 0 16px ${accent}` }}
          />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {consensus?.moniker ?? truncateMiddle(address, 14, 8)}
            </h1>
            <p className="text-sm text-muted-foreground">
              {consensus?.rank ? `Rank #${consensus.rank} · ` : ""}
              {chain.prettyName}
            </p>
          </div>
        </div>

        {consensus?.status ? (
          <span
            className={
              active
                ? "rounded-full bg-[var(--gata-green)]/12 px-3 py-1 text-xs font-medium text-[var(--gata-green)]"
                : "rounded-full bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground"
            }
          >
            {active ? "Active" : consensus.status}
          </span>
        ) : null}
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatPanel
          index={0}
          accent={accent}
          label="Voting Power"
          value={consensus?.votingPower ?? "—"}
          sub="consensus weight"
        />
        <StatPanel
          index={1}
          accent={accent}
          label="Share"
          value={
            consensus?.sharePercent != null
              ? `${consensus.sharePercent.toFixed(2)}%`
              : "—"
          }
        />
        <StatPanel
          index={2}
          accent={accent}
          label="First Committed"
          value={
            consensus?.firstCommittedHeight
              ? `#${consensus.firstCommittedHeight.toLocaleString()}`
              : "—"
          }
          sub={
            consensus?.firstCommittedTime
              ? new Date(consensus.firstCommittedTime).toLocaleDateString()
              : undefined
          }
        />
      </div>

      <div className="gata-panel mb-5" style={{ ["--panel-accent" as string]: accent }}>
        <dl>
          <Row label="Consensus Address">
            <div className="flex items-start gap-2">
              <span className="min-w-0 break-all font-mono text-xs">{address}</span>
              <CopyButton value={address} label="consensus address" />
            </div>
          </Row>
          <Row label="Registry">
            <a
              href="https://gno.land/r/gnops/valopers"
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
            >
              gno.land/r/gnops/valopers
              <ExternalLink className="h-3 w-3" />
            </a>
          </Row>
        </dl>
      </div>

      <Suspense fallback={<ProfileSkeleton />}>
        <ValoperProfilePanel chain={chain} address={address} accent={accent} />
      </Suspense>
    </main>
  );
}
