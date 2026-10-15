"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two or more views sharing one frame.
 *
 * A fixed-height page cannot stack sections - the second one would start below
 * the fold, which is the thing the layout exists to prevent. Where a page
 * genuinely has more than one answer to give, they take turns rather than
 * queue up.
 *
 * A panel is drawn the first time it is opened and then kept, hidden, not
 * unmounted: remounting would throw away the paging position of whichever deck
 * you just left. Panels nobody opens are never drawn, so a page's HTML carries
 * its open tab only (a realm's 1,300-line source file was 336 KB of a page
 * whose Overview was showing).
 *
 * The strip stays one line at every width. When it runs past the edge it fades
 * there, so the tabs out of view read as more to scroll to.
 */
export interface Section {
  key: string;
  label: string;
  content: React.ReactNode;
}

export function SectionTabs({
  sections,
  initial,
  param,
}: {
  sections: Section[];
  /** Tab open on arrival, e.g. from the URL; ignored if no such tab. */
  initial?: string;
  /**
   * Query parameter mirroring the open tab, so a tab can be linked to. The URL
   * is replaced, not pushed: switching tabs is not navigation worth a Back.
   */
  param?: string;
}) {
  const first = sections[0]?.key ?? "";
  const [active, setActiveState] = useState(
    initial && sections.some((s) => s.key === initial) ? initial : first
  );
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set([active]));

  function setActive(key: string) {
    setActiveState(key);
    setOpened((prev) => (prev.has(key) ? prev : new Set([...prev, key])));
    if (!param) return;
    const url = new URL(window.location.href);
    if (key === first) url.searchParams.delete(param);
    else url.searchParams.set(param, key);
    window.history.replaceState(window.history.state, "", url);
  }

  // Fade the strip's right edge while tabs remain beyond it.
  const [more, setMore] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);

  // Keep the open tab in view when it was opened from a link.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Sections"
        className={`flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border pb-1.5 [scrollbar-width:none] sm:pb-2 [&::-webkit-scrollbar]:hidden ${
          more ? "[mask-image:linear-gradient(to_right,black_82%,transparent)]" : ""
        }`}
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
              className={`relative shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] transition-colors sm:px-3 ${
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
          className={section.key === active ? "min-h-0 flex-1 pt-2.5 sm:pt-3" : "hidden"}
        >
          {opened.has(section.key) ? section.content : null}
        </div>
      ))}
    </div>
  );
}
