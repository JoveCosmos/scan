import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

interface LatestBlockResponse {
  block: {
    header: { height: string; time: string; proposer_address: string };
    data: { txs: string[] | null };
  };
}
interface StakingPoolResponse {
  pool: { bonded_tokens: string; not_bonded_tokens: string };
}
interface ValidatorsResponse {
  pagination: { total: string };
}
interface SupplyResponse {
  amount: { denom: string; amount: string };
}

export interface ChainOverview {
  height: string | null;
  blockTime: string | null;
  txCount: number | null;
  activeValidators: number | null;
  bondedRatio: number | null;
  bondedTokens: string | null;
  supply: string | null;
}

/**
 * Head-of-chain summary. Every field degrades independently - one unavailable
 * module renders as "-" rather than failing the whole overview.
 */
export async function getChainOverview(chain: ChainConfig): Promise<ChainOverview> {
  const noStore = { cache: "no-store" as const };

  const [latestBlock, pool, validators, supply] = await Promise.allSettled([
    fetchLcd<LatestBlockResponse>(
      chain,
      "/cosmos/base/tendermint/v1beta1/blocks/latest",
      noStore
    ),
    fetchLcd<StakingPoolResponse>(chain, "/cosmos/staking/v1beta1/pool", noStore),
    fetchLcd<ValidatorsResponse>(chain, "/cosmos/staking/v1beta1/validators", {
      ...noStore,
      searchParams: {
        status: "BOND_STATUS_BONDED",
        "pagination.count_total": true,
        "pagination.limit": 1,
      },
    }),
    fetchLcd<SupplyResponse>(
      chain,
      `/cosmos/bank/v1beta1/supply/by_denom`,
      { ...noStore, searchParams: { denom: chain.denom } }
    ),
  ]);

  let bondedRatio: number | null = null;
  let bondedTokens: string | null = null;
  if (pool.status === "fulfilled") {
    bondedTokens = pool.value.pool.bonded_tokens;

    // Against total supply, not against the staking pool.
    //
    // `not_bonded_tokens` is only the unbonding queue - tokens on their way out
    // of staking - not the circulating remainder. Dividing by
    // bonded + not_bonded gave Cosmos Hub 94.44% when the real figure is
    // 62.59% (327.81M bonded of 523.75M supply), because it was measuring
    // "share of tokens involved in staking at all" rather than "share of supply
    // that is staked".
    const bonded = Number(pool.value.pool.bonded_tokens);
    const total =
      supply.status === "fulfilled" ? Number(supply.value.amount.amount) : NaN;
    if (Number.isFinite(bonded) && Number.isFinite(total) && total > 0) {
      bondedRatio = bonded / total;
    }
  }

  return {
    height: latestBlock.status === "fulfilled" ? latestBlock.value.block.header.height : null,
    blockTime: latestBlock.status === "fulfilled" ? latestBlock.value.block.header.time : null,
    txCount:
      latestBlock.status === "fulfilled"
        ? (latestBlock.value.block.data.txs?.length ?? 0)
        : null,
    activeValidators:
      validators.status === "fulfilled" ? Number(validators.value.pagination.total) : null,
    bondedRatio,
    bondedTokens,
    supply: supply.status === "fulfilled" ? supply.value.amount.amount : null,
  };
}

/** Format a raw base-denom integer string into display units. */
export function formatToken(raw: string | null, exponent: number, maxFrac = 2): string {
  if (raw === null) return "-";
  const n = Number(raw) / 10 ** exponent;
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(maxFrac)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(maxFrac)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(maxFrac)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(maxFrac)}K`;
  return n.toFixed(maxFrac);
}
