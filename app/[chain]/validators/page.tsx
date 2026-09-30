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
import { missedLast30d } from "@/lib/indexer-validator";
import { getSelfBonds } from "@/lib/staking";
import { getChainEconomics, getAprModel } from "@/lib/params";
import { PageFrame } from "@/components/page-frame";
import { withinBudget } from "@/lib/cache";
import { validatorLogoMap } from "@/lib/validator-logos";

export const revalidate = 60;

/** How long an optional read may hold up the page before it is left out. */
const BUDGET = 1500;

/**
 * Shaped like the deck it stands in for - a filter bar over a full-height
 * table - rather than the four stat cards this page used to open with, which
 * the skeleton went on describing long after the cards were gone.
 */
function TableSkeleton({ chain }: { chain: ChainConfig }) {
  return (
    <PageFrame title="Validators" sub={`Active set on ${chain.prettyName}`}>
      <div className="flex h-full flex-col">
        <Skeleton className="h-8 w-full shrink-0 rounded-lg sm:max-w-xs" />
        <Skeleton className="mt-2 min-h-0 flex-1 rounded-none" />
      </div>
    </PageFrame>
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

  // The heading lives in the content now, because the summary beside it is the
  // set itself and cannot be known until the set has been read.
  return (
    <Suspense fallback={<TableSkeleton chain={chain} />}>
      <ValidatorsContent chain={chain} />
    </Suspense>
  );
}

async function ValidatorsContent({ chain }: { chain: ChainConfig }) {
  const chainId = chain.chainId;
  const adapter = getAdapter(chain);
  const metrics = policyFor(chain).metrics;
  const [validators, inactive, registered, overview, chainParams, jailings, missed30] = await Promise.all([
    adapter.getValidators(),
    // Outside the active set. Its own cache, so it never holds up the list once
    // warm; a failed read just leaves the Inactive view empty.
    withinBudget(adapter.getInactiveValidators(), BUDGET, []),
    adapter.getRegisteredCount(),
    // Head height is what anchors the 24h window.
    withinBudget(adapter.getOverview(), BUDGET, null),
    // The commission floor is a consensus parameter, not something derived
    // from the set.
    adapter.capabilities.staking
      ? withinBudget(getChainParams(chain), BUDGET, null)
      : Promise.resolve(null),
    // Null whenever the indexer cannot answer, which hides the column entirely
    // rather than showing every validator a confident zero. Needs nothing from
    // the set, so it runs alongside it rather than after.
    metrics ? withinBudget(jailCounts(chainId), BUDGET, null) : Promise.resolve(null),
    // Missed blocks over 30 days from the index; null hides the column.
    withinBudget(missedLast30d(chainId), BUDGET, null),
  ]);
  const minCommission = chainParams?.staking?.minCommissionRate ?? null;
  // Below the top tier these are skipped rather than fetched and discarded:
  // uptime is a query per validator against endpoints we do not run, and the
  // stake delta needs a second height. The table hides each column when its
  // data is absent, so the page degrades to the set itself.
  // These need the validator set first: they are keyed by the same identifier.
  // Every figure below is optional and budgeted: a cold cache (the first view
  // after a deploy) renders the set at once without the slow columns, and the
  // reads finish in the background so the next view has them.
  const [uptime, deltas, selfBonds, economics, aprModel] = await Promise.all([
    metrics
      ? withinBudget(adapter.getUptime(validators), BUDGET, new Map())
      : Promise.resolve(new Map()),
    metrics
      ? withinBudget(
          adapter.getStakeDeltas(validators, overview?.height ?? null),
          BUDGET,
          new Map()
        )
      : Promise.resolve(new Map()),
    // One request per validator, so it is cached for ten minutes and only
    // gathered where the chain has staking at all - see getSelfBonds.
    adapter.capabilities.staking
      ? withinBudget(getSelfBonds(chain, validators), BUDGET, new Map())
      : Promise.resolve(new Map()),
    // One chain-wide figure. What a delegator actually earns is this less the
    // validator's commission, which is the only part that varies by row.
    adapter.capabilities.staking
      ? withinBudget(
          getChainEconomics(chain, chainParams?.distribution?.communityTax ?? null, null),
          BUDGET,
          null
        )
      : Promise.resolve(null),
    // Where rewards are not purely proportional to stake (AtomOne's nakamoto
    // bonus), each validator's APR depends on its own stake: the heading shows
    // the range and each row its own figure.
    adapter.capabilities.staking
      ? withinBudget(
          getAprModel(
            chain,
            chainParams?.distribution?.communityTax ?? null,
            validators.map((v) => v.tokens)
          ),
          BUDGET,
          null
        )
      : Promise.resolve(null),
  ]);

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

  // Logos for both sets: chainlist images now, Keybase pictures once cached.
  const logos = await validatorLogoMap(chain, [...validators, ...inactive]);

  // Flattened for the client table: it sorts and renders, but owns no fetching.
  const rows: ValidatorRow[] = validators.map((v) => ({
    rank: v.rank,
    operatorAddress: v.operatorAddress,
    moniker: v.moniker,
    logos: logos.get(v.operatorAddress) ?? [],
    apr: aprModel?.at(v.tokens) ?? null,
    votingPower: v.votingPower,
    cumulativePower: v.cumulativePower,
    tokens: v.tokens,
    // Without staking the figure is consensus weight, a plain integer, not a
    // token amount to scale by the denom's exponent.
    tokensLabel: adapter.capabilities.staking
      ? formatToken(v.tokens, chain.exponent)
      : Number(v.tokens).toLocaleString(),
    commissionRate: v.commissionRate,
    jailed: v.jailed,
    status: v.status,
    uptime: uptime.get(v.operatorAddress) ?? emptyUptime(),
    delta: deltas.get(v.operatorAddress) ?? null,
    jailings: jailingsFor(v.consensusPubkey),
    selfBond: selfBonds.get(v.operatorAddress) ?? null,
  }));

  // Outside the set there is no signing to measure and no 24h baseline, and a
  // self-bond read per inactive validator would be hundreds of requests for a
  // column few would sort by - so those stay empty. Jail records do apply.
  const inactiveRows: ValidatorRow[] = inactive.map((v) => ({
    rank: v.rank,
    operatorAddress: v.operatorAddress,
    moniker: v.moniker,
    logos: logos.get(v.operatorAddress) ?? [],
    votingPower: 0,
    cumulativePower: 0,
    tokens: v.tokens,
    tokensLabel: formatToken(v.tokens, chain.exponent),
    commissionRate: v.commissionRate,
    jailed: v.jailed,
    status: v.status,
    uptime: emptyUptime(),
    delta: null,
    jailings: jailingsFor(v.consensusPubkey),
    selfBond: null,
  }));
  const { staking } = adapter.capabilities;

  // How far back the jailing counts reach. Zero jailings means nothing without
  // it - "0" alone could as easily be a validator with a clean record as a
  // window that starts after the last time it was jailed. Formatted here rather
  // than in the component, since a date rendered on the client picks up the
  // browser's locale and disagrees with the server's markup.
  const jailingsSince =
    jailings && !jailings.fromGenesis
      ? new Date(jailings.since).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  // Smallest number of validators that together exceed 1/3 of voting power.
  // One third is the halt threshold: Tendermint needs +2/3 to make progress, so
  // anything over 1/3 colluding can stop the chain. Verified against Cosmos Hub
  // (3 of 200) and AtomOne (6 of 100).
  const nakamoto = validators.findIndex((v) => v.cumulativePower > 1 / 3) + 1;

  const totalBonded = validators.reduce((sum, v) => sum + Number(v.tokens), 0);

  // The rail's five figures move into the heading. On a fixed-height page a
  // rail costs a whole band of rows, and these are context for the table rather
  // than the point of the page - the same figures are bricks on the overview,
  // where they are the point.
  const summary = [
    `${validators.length} validators`,
    ...(metrics && nakamoto > 0 ? [`${nakamoto} could halt`] : []),
    ...(staking
      ? [
          `${formatToken(String(totalBonded), chain.exponent)} ${symbol} bonded`,
          ...(overview?.bondedRatio != null
            ? [`${(overview.bondedRatio * 100).toFixed(1)}% of supply`]
            : []),
          ...(minCommission !== null
            ? [`min commission ${(minCommission * 100).toFixed(1)}%`]
            : []),
          ...(aprModel
            ? [`APR ${(aprModel.lo * 100).toFixed(0)}–${(aprModel.hi * 100).toFixed(0)}%`]
            : economics?.stakingApr != null
              ? [`APR ${(economics.stakingApr * 100).toFixed(1)}%`]
              : []),
        ]
      : [
          `${totalBonded.toLocaleString()} voting power`,
          ...(registered !== null ? [`${registered} registered`] : []),
        ]),
  ].join(" · ");

  // Keyed by operator for the table; a validator the index knows but that
  // missed nothing reads zero, one without a consensus key reads "-".
  const missed30d = missed30
    ? Object.fromEntries(
        validators.flatMap((v) => {
          const hex = v.consensusPubkey
            ? consensusIdsFromPubkey(v.consensusPubkey, chain.bech32Prefix)?.hex
            : null;
          return hex ? [[v.operatorAddress, missed30.get(hex.toUpperCase()) ?? 0]] : [];
        })
      )
    : null;

  return (
    <PageFrame title="Validators" sub={summary} accent={accent}>
      <ValidatorsTable
        chainId={chainId}
        rows={rows}
        inactiveRows={inactiveRows}
        accent={accent}
        symbol={symbol}
        staking={staking}
        hasUptime={metrics}
        jailingsSince={jailingsSince}
        chainApr={economics?.stakingApr ?? null}
        missed30d={missed30d}
      />
    </PageFrame>
  );
}
