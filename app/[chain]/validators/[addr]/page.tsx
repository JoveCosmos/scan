import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getChain, symbolFor, accentFor } from "@/lib/chains";
import { getValidator } from "@/lib/validators";
import { formatToken } from "@/lib/overview";
import { CopyButton } from "@/components/copy-button";
import { GnoValidatorDetail } from "@/components/gno-validator-detail";
import { decodeParam } from "@/lib/format";
import { accountFromOperator, linkedAddresses } from "@/lib/bech32";
import { LinkedAddresses } from "@/components/linked-addresses";
import { StatRail } from "@/components/stat-rail";
import { ValidatorDelegators } from "@/components/validator-delegators";
import { ValidatorStatus } from "@/components/validator-status";
import { ValidatorSlashes } from "@/components/validator-slashes";
import { ValidatorConsensus } from "@/components/validator-consensus";
import { ValidatorGovernance } from "@/components/validator-governance";
import { ValidatorCommission } from "@/components/validator-commission";
import { ValidatorStakeHistory } from "@/components/validator-stake-history";
import { UptimeBars } from "@/components/uptime-bars";
import { getAdapter } from "@/lib/adapter";
import { emptyUptime, DETAIL_BAR_COUNT } from "@/lib/uptime";
import { LoadingPanel } from "@/components/loading-panel";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}): Promise<Metadata> {
  const { chain: chainId, addr: rawAddr } = await params;
  const chain = getChain(chainId);
  if (!chain) return { title: "Validator" };

  const addr = decodeParam(rawAddr);
  // Avoid the Cosmos staking lookup for chains that have no staking module.
  if (chain.kind === "gno") return { title: `Validator ${addr.slice(0, 12)}…` };

  const validator = await getValidator(chain, addr);
  return { title: validator ? validator.moniker : "Validator" };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-4 py-2.5 last:border-0 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export default async function ValidatorDetailPage({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}) {
  const { chain: chainId, addr: rawAddr } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const addr = decodeParam(rawAddr);

  // gno.land has no staking module — identity comes from the valopers realm
  // instead, so it gets an entirely different detail view.
  if (chain.kind === "gno") {
    return <GnoValidatorDetail chain={chain} address={addr} />;
  }

  const validator = await getValidator(chain, addr);
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);
  const selfDelegation = accountFromOperator(addr, chain.bech32Prefix);
  // Derived from the self-delegation account, never from the operator address:
  // re-encoding a …valoper1… under another chain's prefix yields a valid-looking
  // address that is a different entity. linkedAddresses refuses one anyway, so
  // passing the operator here would silently render nothing.
  const links = selfDelegation ? linkedAddresses(selfDelegation) : [];
  const adapter = getAdapter(chain);
  // Shares the validators-page cache key, so opening a validator right after
  // the list costs nothing extra.
  // A longer strip than the list shows: the block reads are per chain, not per
  // validator, so one page can afford more history than 100 rows can.
  const uptime = validator
    ? (
        await adapter
          .getUptime([validator], DETAIL_BAR_COUNT)
          .catch(() => new Map())
      ).get(addr) ?? emptyUptime()
    : emptyUptime();

  const signed =
    uptime.window !== null && uptime.missed !== null
      ? uptime.window - uptime.missed
      : null;

  if (!validator) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-6">
        <Link
          href={`/${chainId}/validators`}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to validators
        </Link>
        <div className="gata-panel px-5 py-10 text-center">
          <h1 className="text-lg font-semibold">Validator not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            No validator with this operator address on {chain.prettyName}.
          </p>
          <p className="mt-4 break-all font-mono text-xs text-muted-foreground">
            {addr}
          </p>
        </div>
      </main>
    );
  }


  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <Link
        href={`/${chainId}/validators`}
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
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {validator.moniker}
            </h1>
            <p className="text-sm text-muted-foreground">
              {validator.rank ? `Rank #${validator.rank}` : "Unranked"} ·{" "}
              {chain.prettyName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {links.length > 0 && (
            <LinkedAddresses links={links} currentChainId={chainId} />
          )}
          <ValidatorStatus
            jailed={validator.jailed}
            status={validator.status}
            tombstoned={uptime.tombstoned}
          />
        </div>
      </div>

      {/* No stat panels. Voting power, stake, self bond, commission and uptime
          are all columns on the list this page was reached from, and repeating
          them here pushed everything that is only on this page below the fold. */}
      {validator.details ? (
        <div className="gata-panel mb-5 px-5 py-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {validator.details}
          </p>
        </div>
      ) : null}

      <div className="gata-panel" style={{ ["--panel-accent" as string]: accent }}>
        <dl>
          <Row label="Operator Address">
            <div className="flex items-start gap-2">
              <span className="min-w-0 break-all font-mono text-xs">
                {validator.operatorAddress}
              </span>
              <CopyButton value={validator.operatorAddress} label="operator address" />
            </div>
          </Row>
          {selfDelegation ? (
            <Row label="Account">
              {/* Same key as the operator address, under the account prefix —
                  the validator's self-delegation address. Links onward to its
                  balances, history and the cross-chain address switcher. */}
              <Link
                href={`/${chainId}/accounts/${selfDelegation}`}
                className="break-all font-mono text-xs text-primary hover:underline"
              >
                {selfDelegation}
              </Link>
            </Row>
          ) : null}
          {validator.website ? (
            <Row label="Website">
              <a
                href={validator.website}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {validator.website}
                <ExternalLink className="h-3 w-3" />
              </a>
            </Row>
          ) : null}
          {validator.securityContact ? (
            <Row label="Security Contact">
              <span className="break-all">{validator.securityContact}</span>
            </Row>
          ) : null}
          {validator.identity ? (
            <Row label="Identity">
              <span className="font-mono text-xs">{validator.identity}</span>
            </Row>
          ) : null}
          <Row label="Commission Rates">
            <span className="font-mono text-xs">
              {(validator.commissionRate * 100).toFixed(2)}% now · max{" "}
              {(validator.maxRate * 100).toFixed(0)}% · max change{" "}
              {(validator.maxChangeRate * 100).toFixed(2)}%/day
            </span>
          </Row>
          {validator.commissionUpdatedAt ? (
            <Row label="Commission Updated">
              {new Date(validator.commissionUpdatedAt).toLocaleString()}
            </Row>
          ) : null}
          <Row label="Min Self Delegation">
            <span className="font-mono text-xs">
              {formatToken(validator.minSelfDelegation, chain.exponent, 6)} {symbol}
            </span>
          </Row>
          <Row label="Outstanding Commission">
            {validator.outstandingCommission.length > 0
              ? validator.outstandingCommission
                  .map(
                    (c) => `${formatToken(c.amount, chain.exponent, 4)} ${symbol}`
                  )
                  .join(", ")
              : "—"}
          </Row>
          {validator.unbondingHeight ? (
            <Row label="Unbonding Since">
              <span className="font-mono text-xs">
                height {Number(validator.unbondingHeight).toLocaleString()}
              </span>
            </Row>
          ) : null}
        </dl>
      </div>

      {uptime.window !== null || uptime.bars.length > 0 ? (
        <>
          <h2 className="mt-5 mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Signing
          </h2>
          <StatRail
            accent={accent}
            // The strip belongs inside the panel, under the counts it summarises.
            note={
              uptime.bars.length > 0 ? (
                <UptimeBars uptime={uptime} slashingWindow className="items-start" />
              ) : undefined
            }
            stats={[
              { label: "Signed", value: signed !== null ? signed.toLocaleString() : "—" },
              {
                label: "Missed",
                value: uptime.missed !== null ? uptime.missed.toLocaleString() : "—",
              },
              {
                label: "Window",
                value: uptime.window !== null ? uptime.window.toLocaleString() : "—",
                sub: "blocks",
              },
              {
                label: "Uptime",
                value:
                  uptime.ratio === null ? "—" : `${(uptime.ratio * 100).toFixed(2)}%`,
              },
            ]}
          />
        </>
      ) : null}

      <Suspense fallback={null}>
        <ValidatorStakeHistory chain={chain} operator={addr} />
      </Suspense>

      <Suspense fallback={null}>
        <ValidatorCommission chain={chain} account={selfDelegation} />
      </Suspense>

      <Suspense fallback={null}>
        <ValidatorGovernance chain={chain} account={selfDelegation} />
      </Suspense>

      <Suspense fallback={null}>
        <ValidatorConsensus
          chain={chain}
          consensusPubkey={validator.consensusPubkey}
          votingPower={validator.votingPower}
        />
      </Suspense>

      <Suspense fallback={null}>
        <ValidatorSlashes
          chain={chain}
          consensusPubkey={validator.consensusPubkey}
        />
      </Suspense>

      <h2 className="mt-5 mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Delegators
      </h2>
      {/* Streamed: a large validator makes this the slowest read on the page. */}
      <Suspense
        fallback={
          <LoadingPanel
            label="Loading delegators…"
            hint="Reading every delegation so the largest are ranked correctly."
            rows={5}
          />
        }
      >
        <ValidatorDelegators chain={chain} operatorAddress={addr} />
      </Suspense>
    </main>
  );
}
