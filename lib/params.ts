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
  if (!value) return "—";
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
  /** Yield after the chain's minimum commission — the best any validator offers. */
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
 * which is why the commission-adjusted figure is given alongside it — a
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

/**
 * How many addresses hold the native denom.
 *
 * Its own function because it is a full scan of every account holding the
 * denom — 2.7s on Cosmos Hub, 25s on AtomOne, whose airdrop left it with over
 * three million holders. Split out so it cannot hold up the rest of the
 * economics, and cached for an hour: a holder count moves slowly, and nothing
 * about it needs to be fresh to the second.
 */
export async function getHolderCount(chain: ChainConfig): Promise<number | null> {
  try {
    return await cached(`holders:${chain.chainId}`, 3_600_000, async () => {
      const res = await fetchLcd<{ pagination?: { total?: string } }>(
        chain,
        `/cosmos/bank/v1beta1/denom_owners/${encodeURIComponent(chain.denom)}`,
        {
          timeoutMs: 30_000,
          searchParams: { "pagination.limit": 1, "pagination.count_total": true },
        }
      );
      const total = Number(res.pagination?.total);
      // Thrown rather than returned so a failure is not cached for an hour.
      if (!Number.isFinite(total)) throw new Error("no holder total");
      return total;
    });
  } catch {
    return null;
  }
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
