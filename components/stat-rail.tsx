import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface Stat {
  label: string;
  value: string;
  sub?: string;
  /** Explanation on hover. These stay numbers, not paragraphs. */
  hint?: string;
}

/**
 * Chain figures as one rail, not a grid of cards.
 *
 * Four panels at 120px each turned a header into a band: the numbers were set
 * at 30px, three times the size of anything on the landing page, and the table
 * they introduce started below the fold. The same figures read better inline —
 * hairline-separated, values at a size that belongs beside body text, the
 * label doing the work above them.
 *
 * The accent hairline along the top comes from .gata-panel, so the rail carries
 * the chain's colour without a coloured box.
 */
export function StatRail({
  stats,
  accent,
  className,
  note,
}: {
  stats: Stat[];
  accent: string;
  className?: string;
  /**
   * Sits under the rule, inside the same panel. For the window a figure is
   * true over — "10,000 blocks indexed since March" — which is part of the
   * claim rather than a caption, and for the signing strip.
   */
  note?: ReactNode;
}) {
  if (stats.length === 0) return null;

  return (
    <div
      className={cn("gata-panel px-1 py-0", className)}
      style={{ ["--panel-accent" as string]: accent }}
    >
      <dl className="flex flex-wrap divide-x divide-border/60">
        {stats.map((s) => (
          <div
            key={s.label}
            title={s.hint}
            className="min-w-[8rem] flex-1 px-4 py-3"
          >
            <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {s.label}
            </dt>
            <dd className="mt-1 font-mono text-xl font-semibold leading-none tracking-tight">
              {s.value}
            </dd>
            {s.sub ? (
              <p className="mt-1 text-[11px] leading-none text-muted-foreground">
                {s.sub}
              </p>
            ) : null}
          </div>
        ))}
      </dl>
      {note ? (
        <div className="border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
          {note}
        </div>
      ) : null}
    </div>
  );
}
