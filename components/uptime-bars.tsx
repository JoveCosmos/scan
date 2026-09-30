import Link from "next/link";
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
  chainId,
  className,
}: {
  /** When given, and the bars carry heights, each bar links to its block. */
  chainId?: string;
  uptime: ValidatorUptime;
  /** True when the percentage comes from the chain's slashing window. */
  slashingWindow: boolean;
  expand?: boolean;
  className?: string;
}) {
  const { bars, ratio, missed, window, barHeights } = uptime;
  const linked = chainId !== undefined && barHeights?.length === bars.length;
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
        {pct === null ? "N/A" : `${pct.toFixed(2)}%`}
      </span>

      {bars.length > 0 ? (
        <span
          className={cn(
            // Expanded, a phone must fit a hundred bars: the gap narrows there.
            expand ? "flex min-h-0 flex-1 items-stretch gap-px sm:gap-[2px]" : "flex items-end gap-[2px]"
          )}
          aria-hidden={linked ? undefined : "true"}
        >
          {bars.map((signed, i) => {
            const cls = cn(
              "rounded-[1px]",
              expand ? "min-w-px flex-1" : "h-3 w-[3px]",
              signed ? "bg-[var(--gata-green)]/70" : "bg-[var(--gata-burn)]",
              linked && "transition-opacity hover:opacity-60"
            );
            if (!linked) return <span key={i} className={cls} />;
            const h = barHeights![i];
            return (
              <Link
                key={i}
                href={`/${chainId}/blocks/${h}`}
                prefetch={false}
                title={`#${h.toLocaleString()} ${signed ? "signed" : "missed"}`}
                aria-label={`Block ${h}, ${signed ? "signed" : "missed"}`}
                className={cls}
              />
            );
          })}
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
