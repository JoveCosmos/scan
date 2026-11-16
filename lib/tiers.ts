import type { ChainConfig } from "@/lib/chains";

/**
 * How much of a chain we undertake to serve.
 *
 * This is policy, not capability. `ChainCapabilities` in lib/adapter.ts says
 * what a chain *can* do - gno.land has no staking module, so no amount of
 * effort produces a delegations page. A tier says what we *choose* to do for a
 * chain we could serve fully: run a full node or a pruned one, and compute the
 * derived metrics or not. Whether the index holds a chain is `indexed` on the
 * chain config - an operational fact, not a level of service.
 *
 * Keeping the two apart matters when reading the UI. A missing Proposals tab on
 * gno.land means the chain has no governance; a missing one on Juno means we
 * decided not to carry it.
 *
 * Nothing here is rendered. A tier carries no label or description because it is
 * never shown to a reader - a chain simply has fewer tabs and fewer columns, with
 * no explanation offered. Read it to gate behaviour; do not print it.
 */
export type Tier = "high" | "medium" | "limited";

export interface TierPolicy {
  tier: Tier;
  /**
   * Derived figures that cost more than reading chain state: the Nakamoto
   * coefficient, uptime histories, proposer counts, 24h stake movement, market
   * and supply data. Off below the top tier - each is several extra queries per
   * page against endpoints we do not run.
   */
  metrics: boolean;
  /** Sections offered. A chain must also have the module - see capabilities. */
  txs: boolean;
  proposals: boolean;
}

const POLICIES: Record<Tier, Omit<TierPolicy, "tier">> = {
  high: {
    metrics: true,
    txs: true,
    proposals: true,
  },
  medium: {
    metrics: false,
    txs: true,
    proposals: true,
  },
  limited: {
    metrics: false,
    txs: false,
    proposals: false,
  },
};

export function policyFor(chain: ChainConfig): TierPolicy {
  return { tier: chain.tier, ...POLICIES[chain.tier] };
}

