"use client";

import { useState } from "react";

/**
 * Two or three views sharing one frame.
 *
 * A fixed-height page cannot stack sections - the second one would start below
 * the fold, which is the thing the layout exists to prevent. Where a page
 * genuinely has more than one answer to give, they take turns rather than
 * queue up.
 *
 * Both panels are rendered and one is hidden, not unmounted: the content is
 * already fetched by the time it gets here, and remounting would throw away the
 * paging position of whichever deck you just left.
 */
export function SectionTabs({
  sections,
  initial,
  param,
}: {
  sections: { key: string; label: string; content: React.ReactNode }[];
  /** Tab open on arrival, e.g. from the URL; ignored if no such tab. */
  initial?: string;
  /**
   * Query parameter mirroring the open tab, so a tab can be linked to. The URL
   * is replaced, not pushed: switching tabs is not navigation worth a Back.
   */
  param?: string;
}) {
  const [active, setActiveState] = useState(
    initial && sections.some((s) => s.key === initial) ? initial : (sections[0]?.key ?? "")
  );

  function setActive(key: string) {
    setActiveState(key);
    if (!param) return;
    const url = new URL(window.location.href);
    if (key === sections[0]?.key) url.searchParams.delete(param);
    else url.searchParams.set(param, key);
    window.history.replaceState(window.history.state, "", url);
  }

  return (
    <div className="flex h-full flex-col">
      <div
        role="tablist"
        aria-label="Sections"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border pb-2 sm:flex-nowrap sm:overflow-x-auto sm:[scrollbar-width:none]"
      >
        {sections.map((section) => {
          const on = section.key === active;
          return (
            <button
              key={section.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActive(section.key)}
              className={`relative shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                on
                  ? "bg-[var(--gata-card-hi)] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {section.label}
            </button>
          );
        })}
      </div>

      {sections.map((section) => (
        <div
          key={section.key}
          role="tabpanel"
          hidden={section.key !== active}
          className={section.key === active ? "min-h-0 flex-1 pt-3" : "hidden"}
        >
          {section.content}
        </div>
      ))}
    </div>
  );
}
