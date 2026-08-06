import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChain, symbolFor, accentFor, type ChainConfig } from "@/lib/chains";
import { Skeleton } from "@/components/ui/skeleton";

import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { ValidatorsTable, type ValidatorRow } from "@/components/validators-table";
import { emptyUptime } from "@/lib/uptime";

export const revalidate = 60;

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
      className="gata-panel gata-panel-interactive gata-rise p-5"
      style={{
        ["--panel-accent" as string]: accent,
        ["--panel-glow" as string]: `${accent}1f`,
        animationDelay: `${index * 60}ms`,
      }}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-3xl font-semibold leading-none">{value}</p>
      {sub ? <p className="mt-2 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[420px] rounded-xl" />
    </div>
  );
}

/**
 * The page shell resolves synchronously so an unknown chain can still produce a
 * real 404; only the slow validator-set read streams in behind Suspense.
 */
export default async function ValidatorsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Validators</h1>
        <p className="text-sm text-muted-foreground">
          Active set on {chain.prettyName}
        </p>
      </div>

      <Suspense fallback={<TableSkeleton />}>
        <ValidatorsContent chain={chain} />
      </Suspense>
    </main>
  );
}

async function ValidatorsContent({ chain }: { chain: ChainConfig }) {
  const chainId = chain.chainId;
  const adapter = getAdapter(chain);
  const [validators, registered, overview] = await Promise.all([
    adapter.getValidators(),
    adapter.getRegisteredCount(),
    // Head height is what anchors the 24h window.
    adapter.getOverview().catch(() => null),
  ]);
  // Both need the validator set first: they are keyed by the same identifier.
  const [uptime, deltas] = await Promise.all([
    adapter.getUptime(validators).catch(() => new Map()),
    adapter
      .getStakeDeltas(validators, overview?.height ?? null)
      .catch(() => new Map()),
  ]);
  const hasDeltas = deltas.size > 0;

  // Flattened for the client table: it sorts and renders, but owns no fetching.
  const rows: ValidatorRow[] = validators.map((v) => ({
    rank: v.rank,
    operatorAddress: v.operatorAddress,
    moniker: v.moniker,
    votingPower: v.votingPower,
    tokens: v.tokens,
    tokensLabel: formatToken(v.tokens, chain.exponent),
    commissionRate: v.commissionRate,
    jailed: v.jailed,
    status: v.status,
    uptime: uptime.get(v.operatorAddress) ?? emptyUptime(),
    delta: deltas.get(v.operatorAddress) ?? null,
  }));
  const { staking, stakeWeighted, registry, slashingWindow } = adapter.capabilities;
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  // Smallest number of validators that together exceed 1/3 of stake — i.e. the
  // number that would have to collude to halt the chain.
  const nakamoto = validators.findIndex((v) => v.cumulativePower > 1 / 3) + 1;

  const totalBonded = validators.reduce((sum, v) => sum + Number(v.tokens), 0);
  const avgCommission =
    validators.length > 0
      ? validators.reduce((sum, v) => sum + v.commissionRate, 0) / validators.length
      : 0;

  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatPanel
          index={0}
          accent={accent}
          label="Active Validators"
          value={String(validators.length)}
          sub={
            registry && registered !== null
              ? `${registered} registered in valopers`
              : undefined
          }
        />
        <StatPanel
          index={1}
          accent={accent}
          label="Nakamoto Coefficient"
          value={nakamoto > 0 ? String(nakamoto) : "—"}
          // On a chain without staking the same figure still measures how many
          // validators must collude to halt consensus — but it is weighted by
          // assigned voting power, not by stake.
          sub={
            stakeWeighted
              ? "to exceed ⅓ of stake"
              : "to exceed ⅓ of voting power"
          }
        />
        {staking ? (
          <>
            <StatPanel
              index={2}
              accent={accent}
              label="Bonded Stake"
              value={formatToken(String(totalBonded), chain.exponent)}
              sub={symbol}
            />
            <StatPanel
              index={3}
              accent={accent}
              label="Avg Commission"
              value={`${(avgCommission * 100).toFixed(1)}%`}
            />
          </>
        ) : (
          <>
            <StatPanel
              index={2}
              accent={accent}
              label="Total Voting Power"
              value={totalBonded.toLocaleString()}
              sub="assigned, not staked"
            />
            <StatPanel
              index={3}
              accent={accent}
              label="Registered"
              value={registered !== null ? String(registered) : "—"}
              sub="valopers realm profiles"
            />
          </>
        )}
      </div>

      <ValidatorsTable
        chainId={chainId}
        rows={rows}
        accent={accent}
        staking={staking}
        hasDeltas={hasDeltas}
        slashingWindow={slashingWindow}
        exponent={chain.exponent}
      />
    </>
  );
}
