import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import type { Coin } from "@/lib/accounts";

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

export interface GovDisplayParams {
  quorum: number | null;
  threshold: number | null;
  vetoThreshold: number | null;
  votingPeriod: string | null;
  minDeposit: Coin[];
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
