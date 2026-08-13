import type { ChainConfig } from "@/lib/chains";

/**
 * How much of a chain we undertake to serve.
 *
 * This is policy, not capability. `ChainCapabilities` in lib/adapter.ts says
 * what a chain *can* do — gno.land has no staking module, so no amount of
 * effort produces a delegations page. A tier says what we *choose* to do for a
 * chain we could serve fully: run a full node or a pruned one, compute the
 * derived metrics or not, index its history or read it live.
 *
 * Keeping the two apart matters when reading the UI. A missing Proposals tab on
 * gno.land means the chain has no governance; a missing one on Juno means we
 * decided not to carry it.
 */
export type Tier = "high" | "medium" | "limited";

export interface TierPolicy {
  tier: Tier;
  /** For the public goods page and anywhere the level is stated outright. */
  label: string;
  /** One line explaining what this level means, shown beside the label. */
  blurb: string;
  /**
   * Derived figures that cost more than reading chain state: the Nakamoto
   * coefficient, uptime histories, proposer counts, 24h stake movement, market
   * and supply data. Off below the top tier — each is several extra queries per
   * page against endpoints we do not run.
   */
  metrics: boolean;
  /**
   * May read from our Postgres index. Off below the top tier: indexing a chain
   * costs disk and a follower process forever, so history for these chains comes
   * from whatever the node still holds.
   */
  indexed: boolean;
  /** We run a full node, so endpoints and snapshots can be published. */
  fullNode: boolean;
  /** Sections offered. A chain must also have the module — see capabilities. */
  txs: boolean;
  proposals: boolean;
  relayers: boolean;
}

const POLICIES: Record<Tier, Omit<TierPolicy, "tier">> = {
  high: {
    label: "High",
    blurb: "Our own full nodes, complete history and every metric.",
    metrics: true,
    indexed: true,
    fullNode: true,
    txs: true,
    proposals: true,
    relayers: true,
  },
  medium: {
    label: "Medium",
    blurb: "Pruned nodes. Current state and history the chain still holds.",
    metrics: false,
    indexed: false,
    fullNode: false,
    txs: true,
    proposals: true,
    relayers: true,
  },
  limited: {
    label: "Limited",
    blurb: "Blocks, validators and parameters only.",
    metrics: false,
    indexed: false,
    fullNode: false,
    txs: false,
    proposals: false,
    relayers: false,
  },
};

export function policyFor(chain: ChainConfig): TierPolicy {
  return { tier: chain.tier, ...POLICIES[chain.tier] };
}

export function policyForTier(tier: Tier): TierPolicy {
  return { tier, ...POLICIES[tier] };
}

/** Highest first, which is the order the public goods page presents them in. */
export const TIER_ORDER: Tier[] = ["high", "medium", "limited"];
