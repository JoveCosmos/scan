import { cn } from "@/lib/utils";
import type { ValidatorUptime } from "@/lib/uptime";

/**
 * Recent signing history as a bar strip, newest on the right — the shape people
 * already read on other explorers. Missed blocks are the whole point, so they
 * are the only ones given a strong colour.
 */
export function UptimeBars({
  uptime,
  slashingWindow,
  className,
}: {
  uptime: ValidatorUptime;
  /** True when the percentage comes from the chain's slashing window. */
  slashingWindow: boolean;
  className?: string;
}) {
  const { bars, ratio, missed, window } = uptime;
  const pct = ratio === null ? null : ratio * 100;

  const tone =
    pct === null
      ? "text-muted-foreground"
      : pct >= 99
        ? "text-[var(--gata-green)]"
        : pct >= 95
          ? "text-[var(--gata-amber)]"
          : "text-[var(--gata-burn)]";

  const title =
    window && missed !== null
      ? `${missed} missed of the last ${window.toLocaleString()} blocks${
          slashingWindow ? " (slashing window)" : ""
        }`
      : "No signing data";

  return (
    <div className={cn("flex flex-col items-end gap-1", className)} title={title}>
      <span className={cn("font-mono text-xs tabular-nums", tone)}>
        {pct === null ? "—" : `${pct.toFixed(2)}%`}
      </span>

      {bars.length > 0 ? (
        <span className="flex items-end gap-[2px]" aria-hidden="true">
          {bars.map((signed, i) => (
            <span
              key={i}
              className={cn(
                "w-[3px] rounded-[1px]",
                signed
                  ? "h-3 bg-[var(--gata-green)]/70"
                  : "h-3 bg-[var(--gata-burn)]"
              )}
            />
          ))}
        </span>
      ) : null}

      {missed !== null && missed > 0 ? (
        <span className="text-[10px] text-muted-foreground">
          {missed.toLocaleString()} missed
        </span>
      ) : null}
    </div>
  );
}
