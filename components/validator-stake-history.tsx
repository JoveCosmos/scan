import type { StakePoint } from "@/lib/indexer-db";
import { formatToken } from "@/lib/overview";

const WIDTH = 640;
const HEIGHT = 100;

/**
 * Bonded stake over the last quarter.
 *
 * The 24h delta answers "did it move"; this answers "what has been happening" —
 * whether a validator has been steadily gaining delegations, bled them after a
 * jailing, or sat flat. validator_stake has held the snapshots all along and
 * nothing read them beyond that one subtraction.
 *
 * Drawn as an inline SVG rather than with a charting library: it is a polyline
 * over sixty points, and adding a dependency for that would cost more in bundle
 * than the feature is worth.
 *
 * The Y axis deliberately does not start at zero. Stake moves by a few percent
 * and a zero-based axis renders every validator as the same flat line — the
 * question here is the shape of the change, and the labelled ends carry the
 * absolute figures.
 *
 * Takes the points rather than reading them. The page needs the series anyway
 * to decide whether this section exists at all, and a second read behind a
 * Suspense boundary would be the one thing a fixed-height layout cannot lay out
 * in advance. Stretched to whatever height the panel gives it — the shape is
 * the content, so there is nothing gained by leaving the rest of the panel
 * empty under a 72-pixel strip.
 */
export function ValidatorStakeChart({
  points,
  exponent,
  symbol,
  accent,
}: {
  points: StakePoint[];
  exponent: number;
  symbol: string;
  accent: string;
}) {
  const values = points.map((p) => Number(p.tokens));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * WIDTH;
    const y = HEIGHT - ((Number(p.tokens) - min) / span) * (HEIGHT - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = values[0];
  const last = values[values.length - 1];
  const change = first > 0 ? (last - first) / first : 0;
  const jailedAt = points.map((p, i) => (p.jailed ? i : -1)).filter((i) => i >= 0);

  return (
    <div className="flex h-full flex-col border border-border bg-[var(--gata-card)] px-4 py-3">
      <div className="flex shrink-0 items-baseline justify-between gap-4">
        <span className="font-mono text-lg font-semibold leading-none">
          {formatToken(String(Math.round(last)), exponent, 2)}{" "}
          <span className="text-xs font-normal text-muted-foreground">{symbol}</span>
        </span>
        <span
          className={
            change >= 0
              ? "font-mono text-sm text-[var(--gata-green)]"
              : "font-mono text-sm text-[var(--gata-burn)]"
          }
        >
          {change >= 0 ? "+" : ""}
          {(change * 100).toFixed(2)}%
        </span>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-3 min-h-0 w-full flex-1"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Bonded stake over the last 90 days, ${
          change >= 0 ? "up" : "down"
        } ${Math.abs(change * 100).toFixed(1)} percent`}
      >
        {/* Fill first so the line sits on top of it. */}
        <polygon
          points={`0,${HEIGHT} ${coords.join(" ")} ${WIDTH},${HEIGHT}`}
          fill={accent}
          opacity={0.12}
        />
        <polyline
          points={coords.join(" ")}
          fill="none"
          stroke={accent}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        {/* A jailing is the one event that explains a cliff, so it is marked. */}
        {jailedAt.map((i) => (
          <circle
            key={i}
            cx={(i / (points.length - 1)) * WIDTH}
            cy={HEIGHT - ((values[i] - min) / span) * (HEIGHT - 8) - 4}
            r={2.5}
            fill="var(--gata-burn)"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="mt-1 flex shrink-0 justify-between text-[11px] text-muted-foreground">
        <span>{new Date(points[0].time).toLocaleDateString()}</span>
        <span>90 days</span>
        <span>{new Date(points[points.length - 1].time).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
