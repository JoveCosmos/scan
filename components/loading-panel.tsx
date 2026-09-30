import { Loader2 } from "lucide-react";

/**
 * Suspense fallback for a section that takes real time to load.
 *
 * A bare skeleton box reads as broken when the wait runs to ten seconds or
 * more, which reconstructing a finished proposal's votes does. This says what
 * is happening and, where useful, why it is slow.
 *
 * Deliberately CSS-only: a Suspense fallback renders before hydration, so a
 * JavaScript-driven spinner would sit motionless exactly when it is needed.
 */
export function LoadingPanel({
  label,
  hint,
  rows = 5,
}: {
  label: string;
  hint?: string;
  rows?: number;
}) {
  return (
    <div className="gata-panel px-5 py-5" role="status" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <span className="text-sm font-medium">{label}</span>
      </div>

      {hint ? (
        <p className="mt-1.5 pl-[26px] text-xs text-muted-foreground">{hint}</p>
      ) : null}

      {/* Shape of the table that is coming, so the panel does not jump when it
          arrives. Hidden from assistive tech - the label above is the message. */}
      <div className="mt-5 space-y-3" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4">
            <div
              className="h-3 animate-pulse rounded bg-muted"
              // Staggered widths read as rows of data rather than a grey block.
              style={{ width: `${58 - (i % 3) * 9}%`, animationDelay: `${i * 90}ms` }}
            />
            <div
              className="ml-auto h-3 w-14 animate-pulse rounded bg-muted"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
