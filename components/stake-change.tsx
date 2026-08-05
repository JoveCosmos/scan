import type { StakeDelta } from "@/lib/stake-delta";

/** Base-denom amount as a compact signed token figure: 83026 -> "+83.0K". */
function compact(change: bigint, exponent: number): string {
  const negative = change < BigInt(0);
  const abs = negative ? -change : change;

  // BigInt down to whole tokens first: a large validator's base-denom stake
  // exceeds what a double holds exactly.
  const whole = Number(abs / BigInt(10) ** BigInt(exponent));
  const sign = negative ? "−" : "+";

  if (whole >= 1_000_000) return `${sign}${(whole / 1_000_000).toFixed(1)}M`;
  if (whole >= 1_000) return `${sign}${(whole / 1_000).toFixed(1)}K`;
  return `${sign}${whole.toLocaleString()}`;
}

/**
 * 24-hour change in a validator's bonded stake.
 *
 * A dash rather than a zero when there is no reading: "no data" and "no change"
 * are different claims, and this one is measured against historical chain state
 * that not every endpoint retains.
 */
export function StakeChange({
  delta,
  exponent,
}: {
  delta: StakeDelta | undefined;
  exponent: number;
}) {
  if (!delta) return <span className="text-muted-foreground">—</span>;

  if (delta.change === BigInt(0)) {
    return <span className="font-mono text-xs text-muted-foreground">—</span>;
  }

  const up = delta.change > BigInt(0);
  return (
    <span
      className={`font-mono text-xs tabular-nums ${
        up ? "text-[var(--gata-green)]" : "text-[var(--gata-burn)]"
      }`}
      title={
        delta.ratio !== null
          ? `${up ? "+" : ""}${(delta.ratio * 100).toFixed(2)}% over 24h`
          : undefined
      }
    >
      {compact(delta.change, exponent)}
    </span>
  );
}
