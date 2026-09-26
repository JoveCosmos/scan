import type { PowerPoint } from "@/lib/indexer-validator";
import { formatDate } from "@/lib/format";

const W = 640;
const H = 100;

/**
 * Consensus voting power as the chain applied it: a step at every
 * validator_update, held flat until the next, extended to the newest block.
 * Exact where stake snapshots are hourly samples, so it is preferred whenever
 * the index covers it. A drop to zero is the validator leaving the active set.
 */
export function ValidatorPowerHistory({
  points,
  accent,
  now = new Date().toISOString(),
}: {
  points: PowerPoint[];
  accent: string;
  now?: string;
}) {
  const t0 = Date.parse(points[0].time);
  const t1 = Math.max(Date.parse(now), Date.parse(points[points.length - 1].time) + 1);
  const values = points.map((p) => Number(p.power));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const lo = min === max ? 0 : min;
  const span = max - lo || 1;
  const x = (t: string) => ((Date.parse(t) - t0) / (t1 - t0)) * W;
  const y = (v: number) => H - ((v - lo) / span) * (H - 8) - 4;

  const path: string[] = [];
  points.forEach((p, i) => {
    const px = x(p.time);
    const py = y(Number(p.power));
    if (i === 0) path.push(`M${px.toFixed(1)},${py.toFixed(1)}`);
    else path.push(`H${px.toFixed(1)}`, `V${py.toFixed(1)}`);
  });
  path.push(`H${W}`);

  const last = values[values.length - 1];
  const first = values[0];
  const change = first > 0 ? (last - first) / first : 0;
  const exits = points.filter((p) => Number(p.power) === 0);

  return (
    <div className="gata-surface flex h-full flex-col px-4 py-3">
      <div className="flex shrink-0 items-baseline justify-between gap-4">
        <span className="font-mono text-lg font-semibold leading-none">
          {last.toLocaleString()} <span className="text-xs font-normal text-muted-foreground">power</span>
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
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 min-h-0 w-full flex-1"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Voting power over ${points.length} changes, ${change >= 0 ? "up" : "down"} ${Math.abs(
          change * 100
        ).toFixed(1)} percent`}
      >
        <path d={`${path.join(" ")} V${H} H0 Z`} fill={accent} opacity={0.12} />
        <path d={path.join(" ")} fill="none" stroke={accent} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {exits.map((p) => (
          <circle
            key={p.height}
            cx={x(p.time)}
            cy={y(0)}
            r={2.5}
            fill="var(--gata-burn)"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="mt-1 flex shrink-0 justify-between font-mono text-[11px] text-muted-foreground">
        <span>{formatDate(points[0].time)}</span>
        <span>{points.length} changes</span>
        <span>{formatDate(now)}</span>
      </div>
    </div>
  );
}
