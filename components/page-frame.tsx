/**
 * A page that fits the screen.
 *
 * The document itself never scrolls — `AppShell` fixes the column to the
 * viewport — so a page is given exactly the height between the header and the
 * footer and has to live inside it. This is the frame that does that: a heading
 * strip that cannot grow, and a body that takes what is left.
 *
 * What a page does with that body is its own business. A board of bricks fits
 * because the detail is in popups; a list fits because it pages internally. The
 * one rule is that neither may push the page taller than the frame.
 */
export function PageFrame({
  title,
  sub,
  accent,
  actions,
  children,
}: {
  title: string;
  sub?: string;
  accent?: string;
  /** Filters, paging, anything that belongs beside the heading. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-3 py-3 sm:px-4 sm:py-4">
      <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {accent ? (
            <span
              aria-hidden="true"
              className="h-7 w-[3px] shrink-0 rounded-full"
              style={{ background: accent, boxShadow: `0 0 12px ${accent}` }}
            />
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight tracking-tight sm:text-xl">
              {title}
            </h1>
            {sub ? (
              <p className="mt-0.5 truncate font-mono text-[11px] leading-tight text-muted-foreground">
                {sub}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
