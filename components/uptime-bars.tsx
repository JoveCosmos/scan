import { cn } from "@/lib/utils";
import type { ValidatorUptime } from "@/lib/uptime";

/**
 * Recent signing history as a bar strip, newest on the right — the shape people
 * already read on other explorers. Missed blocks are the whole point, so they
 * are the only ones given a strong colour.
 *
 * `expand` stretches the same strip to fill whatever it is given, for the panel
 * on a validator's page. A hundred three-pixel bars sitting in the corner of a
 * full-height panel would be the smallest thing on the largest surface, and the
 * information — which of the last hundred blocks this validator missed — is
 * worth the room once it has a panel to itself.
 */
export function UptimeBars({
  uptime,
  slashingWindow,
  expand,
  className,
}: {
  uptime: ValidatorUptime;
  /** True when the percentage comes from the chain's slashing window. */
  slashingWindow: boolean;
  expand?: boolean;
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
    <div
      className={cn(
        "flex flex-col gap-1",
        expand ? "h-full w-full items-stretch" : "items-end",
        className
      )}
      title={title}
    >
      <span
        className={cn(
          "font-mono tabular-nums",
          expand ? "text-sm" : "text-xs",
          tone
        )}
      >
        {pct === null ? "—" : `${pct.toFixed(2)}%`}
      </span>

      {bars.length > 0 ? (
        <span
          className={cn(
            "flex gap-[2px]",
            expand ? "min-h-0 flex-1 items-stretch" : "items-end"
          )}
          aria-hidden="true"
        >
          {bars.map((signed, i) => (
            <span
              key={i}
              className={cn(
                "rounded-[1px]",
                expand ? "min-w-[2px] flex-1" : "h-3 w-[3px]",
                signed ? "bg-[var(--gata-green)]/70" : "bg-[var(--gata-burn)]"
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
