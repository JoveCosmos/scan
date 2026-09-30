import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";

/**
 * Consensus-level chain parameters, gathered from the modules that own them.
 *
 * Every module is read independently and allowed to fail on its own: chains
 * omit modules (AtomOne has no mint module in the usual shape, gno has none of
 * these), and one missing module must not blank the whole page.
 */

export interface StakingParams {
  unbondingTime: string | null;
  maxValidators: number | null;
  maxEntries: number | null;
  historicalEntries: number | null;
  bondDenom: string | null;
  minCommissionRate: number | null;
}

export interface SlashingParams {
  signedBlocksWindow: number | null;
  minSignedPerWindow: number | null;
  downtimeJailDuration: string | null;
  slashFractionDoubleSign: number | null;
  slashFractionDowntime: number | null;
}

export interface MintParams {
  /** Current annual inflation, 0–1. */
  inflation: number | null;
  inflationMax: number | null;
  inflationMin: number | null;
  goalBonded: number | null;
  blocksPerYear: number | null;
}

export interface DistributionParams {
  communityTax: number | null;
  withdrawAddrEnabled: boolean | null;
}

export interface ChainParams {
  staking: StakingParams | null;
  slashing: SlashingParams | null;
  mint: MintParams | null;
  distribution: DistributionParams | null;
}

/** Cosmos returns decimals as strings; "" and nonsense both become null. */
function num(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function getChainParams(chain: ChainConfig): Promise<ChainParams> {
  const [staking, slashing, mintParams, inflation, distribution] = await Promise.all([
    attempt(() =>
      fetchLcd<{
        params?: {
          unbonding_time?: string;
          max_validators?: number;
          max_entries?: number;
          historical_entries?: number;
          bond_denom?: string;
          min_commission_rate?: string;
        };
      }>(chain, "/cosmos/staking/v1beta1/params", { timeoutMs: 8000 })
    ),
    attempt(() =>
      fetchLcd<{
        params?: {
          signed_blocks_window?: string;
          min_signed_per_window?: string;
          downtime_jail_duration?: string;
          slash_fraction_double_sign?: string;
          slash_fraction_downtime?: string;
        };
      }>(chain, "/cosmos/slashing/v1beta1/params", { timeoutMs: 8000 })
    ),
    attempt(() =>
      fetchLcd<{
        params?: {
          inflation_max?: string;
          inflation_min?: string;
          goal_bonded?: string;
          blocks_per_year?: string;
        };
      }>(chain, "/cosmos/mint/v1beta1/params", { timeoutMs: 8000 })
    ),
    attempt(() =>
      fetchLcd<{ inflation?: string }>(chain, "/cosmos/mint/v1beta1/inflation", {
        timeoutMs: 8000,
      })
    ),
    attempt(() =>
      fetchLcd<{
        params?: { community_tax?: string; withdraw_addr_enabled?: boolean };
      }>(chain, "/cosmos/distribution/v1beta1/params", { timeoutMs: 8000 })
    ),
  ]);

  const s = staking?.params;
  const sl = slashing?.params;
  const m = mintParams?.params;
  const d = distribution?.params;

  return {
    staking: s
      ? {
          unbondingTime: s.unbonding_time ?? null,
          maxValidators: s.max_validators ?? null,
          maxEntries: s.max_entries ?? null,
          historicalEntries: s.historical_entries ?? null,
          bondDenom: s.bond_denom ?? null,
          minCommissionRate: num(s.min_commission_rate),
        }
      : null,
    slashing: sl
      ? {
          signedBlocksWindow: num(sl.signed_blocks_window),
          minSignedPerWindow: num(sl.min_signed_per_window),
          downtimeJailDuration: sl.downtime_jail_duration ?? null,
          slashFractionDoubleSign: num(sl.slash_fraction_double_sign),
          slashFractionDowntime: num(sl.slash_fraction_downtime),
        }
      : null,
    // Inflation lives on its own endpoint; keep the block only if either read
    // produced something.
    mint:
      m || inflation?.inflation
        ? {
            inflation: num(inflation?.inflation),
            inflationMax: num(m?.inflation_max),
            inflationMin: num(m?.inflation_min),
            goalBonded: num(m?.goal_bonded),
            blocksPerYear: num(m?.blocks_per_year),
          }
        : null,
    distribution: d
      ? {
          communityTax: num(d.community_tax),
          withdrawAddrEnabled: d.withdraw_addr_enabled ?? null,
        }
      : null,
  };
}

/** "1814400s" -> "21 days". Cosmos expresses durations as second strings. */
export function humanDuration(value: string | null): string {
  if (!value) return "-";
  const seconds = Number(value.replace(/s$/, ""));
  if (!Number.isFinite(seconds)) return value;

  const day = 86_400;
  const hour = 3_600;
  const minute = 60;

  if (seconds >= day) {
    const days = seconds / day;
    return `${Number.isInteger(days) ? days : days.toFixed(1)} day${days === 1 ? "" : "s"}`;
  }
  if (seconds >= hour) {
    const hours = seconds / hour;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds >= minute) {
    const minutes = seconds / minute;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
  }
  return `${seconds}s`;
}

export interface ChainEconomics {
  /** Community pool, native denom only. Pools also hold IBC dust. */
  communityPool: string | null;
  /** Gross annual staking yield before validator commission, 0–1. */
  stakingApr: number | null;
  /** Yield after the chain's minimum commission - the best any validator offers. */
  stakingAprAfterMinCommission: number | null;
}

/**
 * The economic picture: what the chain pays stakers, what it has banked, and
 * how many addresses hold its token.
 *
 * Staking APR is derived, not published by any endpoint:
 *
 *   annual provisions / bonded tokens × (1 − community tax)
 *
 * Newly minted tokens go to stakers in proportion to stake, less the slice
 * diverted to the community pool. The result is before validator commission,
 * which is why the commission-adjusted figure is given alongside it - a
 * headline APR nobody actually receives is worse than no APR.
 */
export async function getChainEconomics(
  chain: ChainConfig,
  communityTax: number | null,
  minCommission: number | null
): Promise<ChainEconomics> {
  const [pool, provisions, staking] = await Promise.all([
    attempt(() =>
      fetchLcd<{ pool?: { denom: string; amount: string }[] }>(
        chain,
        "/cosmos/distribution/v1beta1/community_pool",
        { timeoutMs: 8000 }
      )
    ),
    attempt(() =>
      fetchLcd<{ annual_provisions?: string }>(
        chain,
        "/cosmos/mint/v1beta1/annual_provisions",
        { timeoutMs: 8000 }
      )
    ),
    attempt(() =>
      fetchLcd<{ pool?: { bonded_tokens?: string } }>(
        chain,
        "/cosmos/staking/v1beta1/pool",
        { timeoutMs: 8000 }
      )
    ),
  ]);

  const native = pool?.pool?.find((c) => c.denom === chain.denom);

  const annual = Number(provisions?.annual_provisions ?? NaN);
  const bonded = Number(staking?.pool?.bonded_tokens ?? NaN);
  let stakingApr: number | null = null;
  if (Number.isFinite(annual) && Number.isFinite(bonded) && bonded > 0) {
    stakingApr = (annual / bonded) * (1 - (communityTax ?? 0));
  }

  return {
    // Amounts come back with a decimal tail; the UI formats whole tokens.
    communityPool: native ? native.amount.split(".")[0] : null,
    stakingApr,
    stakingAprAfterMinCommission:
      stakingApr !== null && minCommission !== null
        ? stakingApr * (1 - minCommission)
        : null,
  };
}

/** Total supply of one denom, whole tokens (base units). Null on failure. */
export async function getSupplyOf(
  chain: ChainConfig,
  denom: string
): Promise<string | null> {
  const res = await attempt(() =>
    fetchLcd<{ amount?: { amount?: string } }>(
      chain,
      `/cosmos/bank/v1beta1/supply/by_denom`,
      { timeoutMs: 8000, searchParams: { denom } }
    )
  );
  return res?.amount?.amount ?? null;
}

/**
 * Chain APR with the parameters it depends on, cached. Validator pages each
 * need the chain-wide figure to derive an APR after their own commission, and
 * the underlying reads move on the scale of hours.
 */
export function getChainAprCached(chain: ChainConfig): Promise<{
  stakingApr: number | null;
  minCommission: number | null;
}> {
  return cached(
    `chainapr:${chain.chainId}`,
    10 * 60_000,
    async () => {
      const p = await getChainParams(chain).catch(() => null);
      const economics = await getChainEconomics(
        chain,
        p?.distribution?.communityTax ?? null,
        p?.staking?.minCommissionRate ?? null
      ).catch(() => null);
      return {
        stakingApr: economics?.stakingApr ?? null,
        minCommission: p?.staking?.minCommissionRate ?? null,
      };
    },
    { staleMs: 60 * 60_000 }
  );
}

/**
 * APR range on chains whose rewards are not purely proportional to stake.
 *
 * AtomOne pays a share `e` of the validator reward pool evenly per validator
 * (its "nakamoto bonus"), so a small validator earns more per token than a
 * large one. With R the yearly pool after community tax, S bonded tokens, N
 * active validators and t a validator's stake:
 *
 *   APR(t) = R·(1 − e)/S + R·e/(N·t)
 *
 * - the same model atomone.gatahub.zone renders. The range runs from the
 * largest validator (lowest APR) to the smallest (highest). Null where the
 * chain has no such coefficient: its APR is the single figure above.
 */
export interface AprModel {
  lo: number;
  hi: number;
  /** Gross APR for a validator with this stake (base units), before commission. */
  at: (stake: string | number) => number | null;
}

/** The reward model behind the range, reusable per validator. */
/**
 * The chain-wide inputs of the model, cached: five minutes when the chain has
 * a nakamoto-bonus coefficient, an hour when it does not. Every chain but
 * AtomOne answers "no such endpoint", and asking again on every page load
 * (through each fallback endpoint) is what made the validators tab slow.
 */
async function aprInputs(chain: ChainConfig): Promise<{ e: number; annual: number } | null> {
  const has = await cached(`apr-coef:${chain.chainId}`, 60 * 60_000, async () => {
    const coef = await attempt(() =>
      fetchLcd<{ coefficient?: string }>(
        chain,
        "/cosmos/distribution/v1beta1/nakamoto_bonus_coefficient",
        { timeoutMs: 4000 }
      )
    );
    const e = Number(coef?.coefficient ?? NaN);
    return Number.isFinite(e) ? e : null;
  });
  if (has === null) return null;
  return cached(`apr-inputs:${chain.chainId}`, 5 * 60_000, async () => {
    const [coef, provisions] = await Promise.all([
      attempt(() =>
        fetchLcd<{ coefficient?: string }>(
          chain,
          "/cosmos/distribution/v1beta1/nakamoto_bonus_coefficient",
          { timeoutMs: 4000 }
        )
      ),
      attempt(() =>
        fetchLcd<{ annual_provisions?: string }>(
          chain,
          "/cosmos/mint/v1beta1/annual_provisions",
          { timeoutMs: 4000 }
        )
      ),
    ]);
    const e = Number(coef?.coefficient ?? NaN);
    const annual = Number(provisions?.annual_provisions ?? NaN);
    return Number.isFinite(e) && Number.isFinite(annual) ? { e, annual } : null;
  });
}

export async function getAprModel(
  chain: ChainConfig,
  communityTax: number | null,
  stakes: string[]
): Promise<AprModel | null> {
  if (stakes.length === 0) return null;
  const inputs = await aprInputs(chain);
  if (!inputs) return null;
  const { e, annual } = inputs;
  const R = annual * (1 - (communityTax ?? 0));
  const t = stakes.map(Number).filter((x) => x > 0);
  const S = t.reduce((a, b) => a + b, 0);
  const N = t.length;
  if (S <= 0 || N === 0) return null;
  const apr = (x: number) => (R * (1 - e)) / S + (R * e) / (N * x);
  return {
    lo: apr(Math.max(...t)),
    hi: apr(Math.min(...t)),
    at: (stake) => {
      const x = Number(stake);
      return x > 0 ? apr(x) : null;
    },
  };
}

export async function getAprRange(
  chain: ChainConfig,
  communityTax: number | null,
  stakes: string[]
): Promise<{ lo: number; hi: number } | null> {
  const model = await getAprModel(chain, communityTax, stakes);
  return model ? { lo: model.lo, hi: model.hi } : null;
}
