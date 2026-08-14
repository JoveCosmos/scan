import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChain, symbolFor, accentFor, type ChainConfig } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";
import { Skeleton } from "@/components/ui/skeleton";

import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { ValidatorsTable, type ValidatorRow } from "@/components/validators-table";
import { emptyUptime, consensusIdsFromPubkey } from "@/lib/uptime";
import { getChainParams } from "@/lib/params";
import { jailCounts } from "@/lib/indexer-db";
import { getSelfBonds } from "@/lib/staking";

export const revalidate = 60;

function StatPanel({
  label,
  value,
  sub,
  hint,
  accent,
  index,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Explanation on hover. Kept out of the panel so it stays a number, not a
   *  paragraph — these are read at a glance. */
  hint?: string;
  accent: string;
  index: number;
}) {
  return (
    <div
      title={hint}
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
  const [validators, registered, overview, chainParams] = await Promise.all([
    adapter.getValidators(),
    adapter.getRegisteredCount(),
    // Head height is what anchors the 24h window.
    adapter.getOverview().catch(() => null),
    // The commission floor is a consensus parameter, not something derived
    // from the set.
    adapter.capabilities.staking
      ? getChainParams(chain).catch(() => null)
      : Promise.resolve(null),
  ]);
  const minCommission = chainParams?.staking?.minCommissionRate ?? null;
  // Below the top tier these are skipped rather than fetched and discarded:
  // uptime is a query per validator against endpoints we do not run, and the
  // stake delta needs a second height. The table hides each column when its
  // data is absent, so the page degrades to the set itself.
  const metrics = policyFor(chain).metrics;
  // Both need the validator set first: they are keyed by the same identifier.
  const [uptime, deltas, jailings, selfBonds] = await Promise.all([
    metrics
      ? adapter.getUptime(validators).catch(() => new Map())
      : Promise.resolve(new Map()),
    metrics
      ? adapter
          .getStakeDeltas(validators, overview?.height ?? null)
          .catch(() => new Map())
      : Promise.resolve(new Map()),
    // Null whenever the indexer cannot answer, which hides the column entirely
    // rather than showing every validator a confident zero.
    metrics ? jailCounts(chainId).catch(() => null) : Promise.resolve(null),
    // One request per validator, so it is cached for ten minutes and only
    // gathered where the chain has staking at all — see getSelfBonds.
    adapter.capabilities.staking
      ? getSelfBonds(chain, validators).catch(() => new Map())
      : Promise.resolve(new Map()),
  ]);
  const hasDeltas = deltas.size > 0;

  /** Slashing events carry the consensus address, so rows are matched on that. */
  const jailingsFor = (consensusPubkey: string | null) => {
    if (!jailings || !consensusPubkey) return null;
    const ids = consensusIdsFromPubkey(consensusPubkey, chain.bech32Prefix);
    if (!ids) return null;
    return {
      count: jailings.byConsAddr.get(ids.valcons) ?? 0,
      tombstoned: jailings.tombstoned.has(ids.valcons),
    };
  };

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
    jailings: jailingsFor(v.consensusPubkey),
    selfBond: selfBonds.get(v.operatorAddress) ?? null,
  }));
  const { staking, stakeWeighted, registry, slashingWindow } = adapter.capabilities;
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  // Smallest number of validators that together exceed 1/3 of voting power.
  // One third is the halt threshold: Tendermint needs +2/3 to make progress, so
  // anything over 1/3 colluding can stop the chain. Verified against Cosmos Hub
  // (3 of 200) and AtomOne (6 of 100).
  const nakamoto = validators.findIndex((v) => v.cumulativePower > 1 / 3) + 1;

  const totalBonded = validators.reduce((sum, v) => sum + Number(v.tokens), 0);

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
        {/* Cheap to compute — it is a scan of the set already in memory — but it
            is analysis rather than chain state, so it belongs with the other
            derived figures that lower tiers do not carry. */}
        {metrics ? (
          <StatPanel
            index={1}
            accent={accent}
            label="Could Halt The Chain"
            value={nakamoto > 0 ? String(nakamoto) : "—"}
            // "Nakamoto coefficient" means nothing to most readers, so the panel
            // states the consequence and the term lives in the tooltip.
            sub={nakamoto > 0 ? `of ${validators.length} validators` : undefined}
            hint={
              stakeWeighted
                ? `The ${nakamoto} largest validators together hold more than a third of all staked ${symbol}. Tendermint needs over two thirds agreeing to produce blocks, so a third acting together can stop it. Higher is safer.`
                : `The ${nakamoto} largest validators together hold more than a third of voting power, which on this chain is assigned rather than staked. Over a third acting together can halt consensus. Higher is safer.`
            }
          />
        ) : null}
        {staking ? (
          <>
            <StatPanel
              index={2}
              accent={accent}
              label="Bonded Stake"
              value={`${formatToken(String(totalBonded), chain.exponent)} ${symbol}`}
              sub={
                overview?.bondedRatio != null
                  ? `${(overview.bondedRatio * 100).toFixed(2)}% of supply`
                  : undefined
              }
              hint="Share of total supply that is staked. Stake secures the chain, so a higher share means a more expensive chain to attack - and less supply free to trade."
            />
            <StatPanel
              index={3}
              accent={accent}
              label="Min Commission"
              value={
                minCommission !== null ? `${(minCommission * 100).toFixed(1)}%` : "—"
              }
              sub="chain floor"
              hint="No validator on this chain may charge less than this. It is a consensus parameter, not an average of what validators actually charge."
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
        hasUptime={metrics}
        slashingWindow={slashingWindow}
        exponent={chain.exponent}
        jailingsSince={jailings?.since ?? null}
      />
    </>
  );
}
