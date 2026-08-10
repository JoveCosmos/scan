import type { ChainConfig } from "@/lib/chains";
import { accentFor } from "@/lib/chains";
import { proposerStats } from "@/lib/indexer-db";
import { consensusIdsFromPubkey } from "@/lib/uptime";
import { timeAgo } from "@/lib/format";

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
      <h2 className="mt-6 mb-3 text-sm font-medium text-muted-foreground">
        Consensus participation
      </h2>
      <div
        className="gata-panel px-5 py-4"
        style={{ ["--panel-accent" as string]: accent }}
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric
            label="Blocks proposed"
            value={stats.proposed.toLocaleString()}
          />
          <Metric
            label="Share of blocks"
            value={`${(share * 100).toFixed(2)}%`}
            sub={
              expected !== null
                ? `${(expected * 100).toFixed(2)}% of stake`
                : undefined
            }
          />
          <Metric
            label="Versus stake"
            value={ratio !== null ? `${ratio.toFixed(2)}x` : "-"}
            sub={ratio !== null ? verdict(ratio) : undefined}
          />
          <Metric
            label="Last proposed"
            value={stats.lastTime ? timeAgo(stats.lastTime) : "Never"}
            sub={
              stats.lastHeight
                ? `block ${stats.lastHeight.toLocaleString()}`
                : undefined
            }
          />
        </dl>

        <p className="mt-4 text-xs text-muted-foreground">
          Across {stats.totalBlocks.toLocaleString()} blocks indexed since{" "}
          {since}. Proposer turns are awarded in proportion to voting power, so a
          healthy validator proposes close to its stake share over a long window.
          Well under 1.00x means it is bonded but missing turns - which the
          signing percentage above cannot show, since that measures signing other
          validators&apos; blocks.
        </p>
      </div>
    </>
  );
}

/**
 * Deliberately cautious wording. Proposer selection is random in the short run
 * and the window includes time at a different voting power, so a modest gap is
 * noise rather than evidence.
 */
function verdict(ratio: number): string {
  if (ratio >= 0.95) return "in line with stake";
  if (ratio >= 0.85) return "slightly under";
  return "well under - missing turns";
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-medium tabular-nums">{value}</dd>
      {sub ? (
        <dd className="text-xs text-muted-foreground">{sub}</dd>
      ) : null}
    </div>
  );
}
