import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { getBlock } from "@/lib/blocks";
import { cached } from "@/lib/cache";
import { stakeBaseline } from "@/lib/indexer-db";

/**
 * Change in each validator's bonded stake over the last 24 hours.
 *
 * Two baselines, tried in that order.
 *
 * Our own snapshots, when the indexer has been recording them for a day. This
 * is the only source that does not depend on somebody else keeping historical
 * state around.
 *
 * Otherwise a node's state at yesterday's height, via `x-cosmos-block-height` —
 * the whole set in one request rather than one per validator. Only archive
 * nodes retain it: on AtomOne one public endpoint answers 500 and the other is
 * a rotating proxy, archive on one request and pruned on the next. That is what
 * made this column appear and vanish between refreshes, and why the result is
 * cached under a key that does not move with the height.
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

  // Before anything is measured or fetched: the snapshot path needs neither a
  // head height nor a block time, and computing them first would be work done
  // only to be thrown away on every chain we index.
  const snapshot = await stakeBaseline(chain.chainId).catch(() => null);
  if (snapshot) return compare(current, snapshot);

  const head = Number(headHeight);
  if (!Number.isFinite(head) || head <= 0) return out;

  const seconds = await blockSeconds(chain, head);
  const then = head - Math.max(1, Math.round(86_400 / seconds));
  if (then <= 1) return out;

  //
  // Keyed by chain alone, deliberately, even though the height it reads moves
  // every block. A height-keyed entry would be a fresh key every time and so
  // never a hit — which is what made this column flicker: only some endpoints
  // retain state 14,000 blocks back, `fetchLcd` fails over between them, and
  // the toss was re-thrown on every request. One key means cached() keeps
  // serving the last good baseline through a node that refuses, and the column
  // stops appearing and vanishing between refreshes.
  //
  // The baseline then drifts by up to the TTL. On a 24-hour indicator, ten
  // minutes is not a meaningful difference.
  const before = await cached(
    `stake-baseline:${chain.chainId}`,
    600_000,
    async () => {
      const past = await fetchLcd<RawSet>(
        chain,
        "/cosmos/staking/v1beta1/validators",
        {
          cache: "no-store",
          timeoutMs: 12_000,
          searchParams: {
            status: "BOND_STATUS_BONDED",
            "pagination.limit": 500,
          },
          headers: { "x-cosmos-block-height": String(then) },
        }
      );
      // Strings, not BigInt: this is a cached value and stays comparable if the
      // cache ever grows a serialising layer.
      return new Map(
        (past.validators ?? []).map((v) => [v.operator_address, v.tokens])
      );
    }
    // Pruned node with nothing cached yet: no column rather than a fabricated
    // one. Once any read succeeds, that stays the baseline until one does again.
  ).catch(() => null);

  if (!before) return out;

  return compare(current, before);
}

/** Current stake against a baseline, whichever source the baseline came from. */
export function compare(
  current: { operatorAddress: string; tokens: string }[],
  before: Map<string, string>
): Map<string, StakeDelta> {
  const out = new Map<string, StakeDelta>();

  for (const v of current) {
    const raw = before.get(v.operatorAddress);
    // A validator absent 24h ago (newly bonded) has no baseline to compare
    // against; showing "+everything" would be misleading.
    if (raw === undefined) continue;

    const prior = BigInt(raw);
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
