import Link from "next/link";
import type { SigningHistory, SigningWindow } from "@/lib/indexer-validator";
import { formatDate } from "@/lib/format";

const W = 720;
const H = 96;

function pct(w: SigningWindow | null): string {
  if (!w || w.ratio === null) return "N/A";
  return `${(w.ratio * 100).toFixed(w.ratio >= 0.9995 ? 2 : 3)}%`;
}

/**
 * A validator's signing record from the index: reliability over 30 and 90
 * days and all covered history, missed blocks per day as bars, and the runs
 * of consecutive misses, each linked to where it started.
 *
 * The chart draws misses only. A day with none keeps a faint baseline tick so
 * the eye reads "nothing missed" rather than "no data", and the tallest bar is
 * labelled so the scale is never a guess.
 */
export function ValidatorSigningHistory({
  history,
  chainId,
}: {
  history: SigningHistory;
  chainId: string;
}) {
  const days = history.daily;
  const max = Math.max(1, ...days.map((d) => d.missed));
  const slot = W / Math.max(1, days.length);
  const bar = Math.max(1, slot - 2);
  const total = days.reduce((s, d) => s + d.missed, 0);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11.5px]">
        <Fact label="30d" value={pct(history.d30)} tone={history.d30} />
        <Fact label="90d" value={pct(history.d90)} tone={history.d90} />
        <Fact label="since" value={formatDate(history.coverage.loTime)} />
        <Fact label="all" value={pct(history.all)} tone={history.all} />
        <Fact label="missed" value={history.all.missed.toLocaleString()} />
        {history.longest ? (
          <Fact label="longest run" value={history.longest.length.toLocaleString()} />
        ) : null}
        {history.nil > 0 ? <Fact label="nil votes" value={history.nil.toLocaleString()} /> : null}
      </div>

      <figure className="m-0 shrink-0">
        <svg
          viewBox={`0 0 ${W} ${H + 14}`}
          className="h-28 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Missed blocks per day over ${days.length} days: ${total} in total, at most ${max} in a day`}
        >
          <line x1={0} y1={H} x2={W} y2={H} stroke="var(--gata-border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={0} x2={W} y2={0} stroke="var(--gata-border)" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          {days.map((d, i) => {
            const x = i * slot + (slot - bar) / 2;
            if (d.missed === 0) {
              return <rect key={d.day} x={x} y={H - 1} width={bar} height={1} fill="var(--gata-border-hi)" />;
            }
            const h = Math.max(2, (d.missed / max) * (H - 4));
            return (
              <rect key={d.day} x={x} y={H - h} width={bar} height={h} rx={1} fill="var(--gata-burn)" opacity={0.85}>
                <title>{`${d.day}: ${d.missed.toLocaleString()} missed`}</title>
              </rect>
            );
          })}
        </svg>
        <figcaption className="mt-1 flex justify-between font-mono text-[10.5px] text-muted-foreground">
          <span>{days[0]?.day ?? ""}</span>
          <span>max {max.toLocaleString()} / day</span>
          <span>{days[days.length - 1]?.day ?? ""}</span>
        </figcaption>
      </figure>

      {history.recent.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <th className="py-1 font-medium">Run</th>
                <th className="py-1 text-right font-medium">Blocks</th>
              </tr>
            </thead>
            <tbody>
              {history.recent.map((r) => (
                <tr key={r.from} className="border-t border-border/40">
                  <td className="py-1">
                    <Link
                      href={`/${chainId}/blocks/${r.from}`}
                      className="text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
                    >
                      #{r.from.toLocaleString()}
                    </Link>
                    {r.to !== r.from ? (
                      <span className="text-muted-foreground"> – #{r.to.toLocaleString()}</span>
                    ) : null}
                  </td>
                  <td className="py-1 text-right">{r.length.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: SigningWindow | null }) {
  const ratio = tone?.ratio ?? null;
  const color =
    ratio === null ? undefined : ratio >= 0.99 ? "var(--gata-green)" : ratio >= 0.95 ? "var(--gata-amber)" : "var(--gata-burn)";
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5 leading-5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold" style={color ? { color } : undefined}>
        {value}
      </span>
    </span>
  );
}
