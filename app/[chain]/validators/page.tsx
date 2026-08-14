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
import { getChainEconomics } from "@/lib/params";
import { StatRail } from "@/components/stat-rail";

export const revalidate = 60;

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
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Validators</h1>
        <p className="text-xs text-muted-foreground">
          active set on {chain.prettyName}
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
  const [uptime, deltas, jailings, selfBonds, economics] = await Promise.all([
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
    // One chain-wide figure. What a delegator actually earns is this less the
    // validator's commission, which is the only part that varies by row.
    adapter.capabilities.staking
      ? getChainEconomics(
          chain,
          chainParams?.distribution?.communityTax ?? null,
          null
        ).catch(() => null)
      : Promise.resolve(null),
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
      <StatRail
        className="mb-4"
        accent={accent}
        stats={[
          {
            label: "Active Validators",
            value: String(validators.length),
            sub:
              registry && registered !== null
                ? `${registered} in valopers`
                : undefined,
          },
          // Analysis rather than chain state, so it goes with the other derived
          // figures the lower tiers do not carry.
          ...(metrics
            ? [
                {
                  label: "Could Halt",
                  value: nakamoto > 0 ? String(nakamoto) : "—",
                  sub: nakamoto > 0 ? `of ${validators.length}` : undefined,
                  hint: stakeWeighted
                    ? `The ${nakamoto} largest validators together hold more than a third of all staked ${symbol}. Tendermint needs over two thirds agreeing to produce blocks, so a third acting together can stop it. Higher is safer.`
                    : `The ${nakamoto} largest validators together hold more than a third of voting power, which on this chain is assigned rather than staked. Over a third acting together can halt consensus. Higher is safer.`,
                },
              ]
            : []),
          ...(staking
            ? [
                {
                  label: "Bonded Stake",
                  value: `${formatToken(String(totalBonded), chain.exponent)} ${symbol}`,
                  sub:
                    overview?.bondedRatio != null
                      ? `${(overview.bondedRatio * 100).toFixed(2)}% of supply`
                      : undefined,
                  hint: "Share of total supply that is staked. Stake secures the chain, so a higher share means a more expensive chain to attack - and less supply free to trade.",
                },
                {
                  label: "Min Commission",
                  value:
                    minCommission !== null
                      ? `${(minCommission * 100).toFixed(1)}%`
                      : "—",
                  sub: "chain floor",
                  hint: "No validator on this chain may charge less than this. It is a consensus parameter, not an average of what validators actually charge.",
                },
                ...(economics?.stakingApr != null
                  ? [
                      {
                        label: "Staking APR",
                        value: `${(economics.stakingApr * 100).toFixed(1)}%`,
                        sub: "before commission",
                      },
                    ]
                  : []),
              ]
            : [
                {
                  label: "Voting Power",
                  value: totalBonded.toLocaleString(),
                  sub: "assigned, not staked",
                },
                {
                  label: "Registered",
                  value: registered !== null ? String(registered) : "—",
                  sub: "valopers profiles",
                },
              ]),
        ]}
      />

      <ValidatorsTable
        chainId={chainId}
        rows={rows}
        accent={accent}
        staking={staking}
        hasDeltas={hasDeltas}
        hasUptime={metrics}
        grossApr={economics?.stakingApr ?? null}
        slashingWindow={slashingWindow}
        exponent={chain.exponent}
        jailingsSince={jailings?.since ?? null}
      />
    </>
  );
}
