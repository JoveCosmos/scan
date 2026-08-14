import type { ChainConfig } from "@/lib/chains";
import { accentFor } from "@/lib/chains";
import { proposerStats } from "@/lib/indexer-db";
import { consensusIdsFromPubkey } from "@/lib/uptime";
import { timeAgo } from "@/lib/format";
import { StatRail } from "@/components/stat-rail";

/**
 * How much of the chain's block production this validator actually did.
 *
 * Distinct from the signing percentage above it, which measures whether the
 * validator signed *other* proposers' blocks. A validator can sign reliably and
 * still fail to produce its own when its turn comes; only the proposed share
 * shows that. Because proposer selection is weighted by voting power, the two
 * shares should converge over a long enough window, and the gap between them is
 * the interesting number.
 *
 * Renders nothing without the indexer. Nothing here is answerable from a node:
 * it requires having walked every block and recorded who proposed it.
 */
export async function ValidatorConsensus({
  chain,
  consensusPubkey,
  votingPower,
}: {
  chain: ChainConfig;
  consensusPubkey: string | null;
  /** Share of bonded stake, 0-1. The share of blocks this validator should win. */
  votingPower: number | null;
}) {
  if (!consensusPubkey) return null;

  const ids = consensusIdsFromPubkey(consensusPubkey, chain.bech32Prefix);
  if (!ids) return null;

  const stats = await proposerStats(chain.chainId, ids.hex);
  if (!stats || stats.totalBlocks === 0) return null;

  const accent = accentFor(chain);
  const share = stats.proposed / stats.totalBlocks;

  // Expected turns, from voting power. Null when we cannot say, rather than
  // assuming the current power held across the whole window — it did not.
  const expected = votingPower !== null ? votingPower : null;
  const ratio = expected && expected > 0 ? share / expected : null;

  const since = new Date(stats.since).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <>
      <h2 className="mt-5 mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Consensus participation
      </h2>
      <StatRail
        accent={accent}
        // Stated only when the index does not reach the first block. Once the
        // backfill lands on genesis, "since <genesis date>" is the chain's own
        // age dressed as a caveat — it tells a reader nothing except that a
        // limit might exist.
        note={
          stats.fromGenesis
            ? `${stats.totalBlocks.toLocaleString()} blocks, all of them`
            : `${stats.totalBlocks.toLocaleString()} blocks indexed since ${since}`
        }
        stats={[
          { label: "Blocks proposed", value: stats.proposed.toLocaleString() },
          {
            label: "Share of blocks",
            value: `${(share * 100).toFixed(2)}%`,
            sub: expected !== null ? `${(expected * 100).toFixed(2)}% of stake` : undefined,
          },
          {
            label: "Versus stake",
            value: ratio !== null ? `${ratio.toFixed(2)}x` : "-",
            sub: ratio !== null ? verdict(ratio) : undefined,
          },
          {
            label: "Last proposed",
            value: stats.lastTime ? timeAgo(stats.lastTime) : "Never",
            sub: stats.lastHeight ? `block ${stats.lastHeight.toLocaleString()}` : undefined,
          },
        ]}
      />
    </>
  );
}

function verdict(ratio: number): string {
  if (ratio >= 0.95) return "in line with stake";
  if (ratio >= 0.85) return "slightly under";
  return "well under - missing turns";
}

