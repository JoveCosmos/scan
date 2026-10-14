/**
 * One bar per UTC day, oldest left, the scale from the largest day. Days with
 * nothing are filled in, so the bars line up with the calendar. Server-rendered
 * SVG: no chart library, and the hover title carries each day's figure.
 */
export function DayBars({
  title,
  points,
  days = 90,
  format,
  total,
  accent,
}: {
  title: string;
  points: { day: string; v: number }[];
  days?: number;
  /** A value as shown: in the hover titles and the total. */
  format: (v: number) => string;
  /** Shown top right; defaults to the sum. */
  total?: string;
  accent: string;
}) {
  const byDay = new Map(points.map((p) => [p.day, p.v]));
  const series: { day: string; v: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, v: byDay.get(key) ?? 0 });
  }
  const max = Math.max(1e-9, ...series.map((d) => d.v));
  const W = 900;
  const H = 70;
  const bw = W / series.length;
  return (
    <section className="gata-surface shrink-0 px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium uppercase tracking-[0.1em]">{title}</span>
        <span className="font-mono">{total ?? format(series.reduce((s, d) => s + d.v, 0))}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[70px] w-full" preserveAspectRatio="none" role="img" aria-label={title}>
        {series.map((d, i) => {
          const h = d.v > 0 ? Math.max(1.5, (d.v / max) * (H - 2)) : 0;
          return (
            <rect key={d.day} x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1.5)} height={h} rx={1} fill={accent} opacity={0.85}>
              <title>{`${d.day}: ${format(d.v)}`}</title>
            </rect>
          );
        })}
      </svg>
    </section>
  );
}
