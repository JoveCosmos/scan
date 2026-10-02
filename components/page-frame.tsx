/**
 * The figures under a title arrive as one " · "-joined line. Each becomes its
 * own chip, with the number set apart from the words, so a heading like
 * "100 validators · 62.72M ATONE bonded · APR 47.4%" reads as three facts
 * rather than one sentence.
 */
function splitFact(fact: string): { value: string; label: string; valueFirst: boolean } | null {
  const lead = fact.match(/^([-+$#]?[\d.,]+[KMBT%]?(?:\s[A-Z]{2,6})?)\s+(.+)$/);
  if (lead) return { value: lead[1], label: lead[2], valueFirst: true };
  const tail = fact.match(/^(.+?)\s+([-+$#]?[\d.,]+[KMBT%]?)$/);
  if (tail) return { value: tail[2], label: tail[1], valueFirst: false };
  return null;
}

function Facts({ sub }: { sub: string }) {
  const facts = sub.split(" · ").filter(Boolean);
  return (
    // One line on phones, sliding sideways: wrapped, the chips took up to three
    // rows of a screen the list below needs.
    <ul className="flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden">
      {facts.map((fact, i) => {
        const parts = splitFact(fact);
        return (
          <li
            key={i}
            className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5 text-[11.5px] leading-5"
          >
            {parts ? (
              parts.valueFirst ? (
                <>
                  <span className="font-mono font-semibold text-foreground">{parts.value}</span>
                  <span className="text-muted-foreground">{parts.label}</span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">{parts.label}</span>
                  <span className="font-mono font-semibold text-foreground">{parts.value}</span>
                </>
              )
            ) : (
              <span className="text-muted-foreground">{fact}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A page that fits the screen.
 *
 * The document itself never scrolls - `AppShell` fixes the column to the
 * viewport - so a page is given exactly the height between the header and the
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
  emblem,
  actions,
  children,
}: {
  title: string;
  sub?: string;
  accent?: string;
  /** A logo beside the title: the chain's, or the validator's avatar. */
  emblem?: React.ReactNode;
  /** Filters, paging, anything that belongs beside the heading. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // The same width and gutter as the header, so the page's edges line up
    // with the tabs above it at every screen size.
    <div className="relative mx-auto flex h-full max-w-[90rem] flex-col px-4 py-2.5 sm:py-4">
      {/* A soft wash of the chain's accent behind the heading. */}
      {accent ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-0 -z-10 h-64 w-[36rem] max-w-full opacity-60 blur-3xl"
          style={{ background: `radial-gradient(closest-side, color-mix(in srgb, ${accent} 22%, transparent), transparent)` }}
        />
      ) : null}
      {/* The title and its figures share one row: the figures follow the
          title inline and wrap under it only when the row runs out. */}
      <div className="flex shrink-0 items-center justify-between gap-3 pb-2.5 pt-0.5 sm:pb-3.5 sm:pt-1">
        <div className="flex min-w-0 items-center gap-3">
          {emblem ? (
            <span className="shrink-0">{emblem}</span>
          ) : accent ? (
            <span
              aria-hidden="true"
              className="h-7 w-1 shrink-0 self-start rounded-full sm:self-center"
              style={{ background: accent, boxShadow: `0 0 14px ${accent}` }}
            />
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="font-display max-w-full truncate text-[20px] font-semibold leading-tight tracking-[-0.02em] sm:text-[22px]">
              {title}
            </h1>
            {sub ? (
              sub.includes(" · ") ? (
                <Facts sub={sub} />
              ) : (
                <p className="truncate font-mono text-[12px] leading-tight text-muted-foreground">
                  {sub}
                </p>
              )
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
