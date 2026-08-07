import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { getBlock } from "@/lib/blocks";
import { cached } from "@/lib/cache";

/**
 * Change in each validator's bonded stake over the last 24 hours.
 *
 * Cosmos nodes serve historical state through the `x-cosmos-block-height`
 * header, so the whole set at yesterday's height costs one request — not one
 * per validator. Measured on Cosmos Hub: ~0.65s for all 200.
 *
 * Not every node retains that state. A pruned node answers 501/error rather
 * than lying, and the column then renders as "—" instead of a wrong number.
 */

interface RawSet {
  validators?: { operator_address: string; tokens: string }[];
}

/** Sampled over this many blocks. Long enough that a single slow block does not
 *  skew the average, short enough to stay on a pruned node's retained range. */
const BLOCK_SAMPLE = 2000;

/**
 * Seconds per block, measured rather than configured, so adding a chain needs
 * no timing constant. Cached for an hour — block time barely moves.
 *
 * Falls back to 6s (the Cosmos Hub norm) if the sample cannot be read. A small
 * error here only shifts the window slightly, e.g. 23.5h instead of 24h, which
 * a "24h change" indicator tolerates.
 */
export async function blockSeconds(chain: ChainConfig, head: number): Promise<number> {
  return cached(`blocktime:${chain.chainId}`, 3_600_000, async () => {
    try {
      const [now, before] = await Promise.all([
        getBlock(chain, head),
        getBlock(chain, head - BLOCK_SAMPLE),
      ]);
      const dt =
        (new Date(now.time).getTime() - new Date(before.time).getTime()) / 1000;
      const seconds = dt / BLOCK_SAMPLE;
      return seconds > 0.1 && seconds < 120 ? seconds : 6;
    } catch {
      return 6;
    }
  });
}

export interface StakeDelta {
  /** Change in base denom over the window. Negative means stake left. */
  change: bigint;
  /** Fraction of the earlier total, 0–1, signed. Null when it was zero. */
  ratio: number | null;
}

export async function getStakeDeltas(
  chain: ChainConfig,
  current: { operatorAddress: string; tokens: string }[],
  headHeight: string | null
): Promise<Map<string, StakeDelta>> {
  const out = new Map<string, StakeDelta>();
  const head = Number(headHeight);
  if (!Number.isFinite(head) || head <= 0) return out;

  const seconds = await blockSeconds(chain, head);
  const then = head - Math.max(1, Math.round(86_400 / seconds));
  if (then <= 1) return out;

  let past: RawSet;
  try {
    past = await fetchLcd<RawSet>(chain, "/cosmos/staking/v1beta1/validators", {
      cache: "no-store",
      timeoutMs: 12_000,
      searchParams: {
        status: "BOND_STATUS_BONDED",
        "pagination.limit": 500,
      },
      headers: { "x-cosmos-block-height": String(then) },
    });
  } catch {
    // Pruned node, or one that rejects historical reads. No column rather than
    // a fabricated one.
    return out;
  }

  const before = new Map(
    (past.validators ?? []).map((v) => [v.operator_address, BigInt(v.tokens)])
  );

  for (const v of current) {
    const prior = before.get(v.operatorAddress);
    // A validator absent 24h ago (newly bonded) has no baseline to compare
    // against; showing "+everything" would be misleading.
    if (prior === undefined) continue;

    const change = BigInt(v.tokens) - prior;
    out.set(v.operatorAddress, {
      change,
      ratio:
        prior > BigInt(0)
          ? Number((change * BigInt(1_000_000)) / prior) / 1_000_000
          : null,
    });
  }

  return out;
}
