"use client";

import { useState } from "react";

/**
 * Two lists side by side from lg, taking turns below it.
 *
 * Each list is rendered once whatever the width: the inactive one is hidden
 * with CSS on narrow screens, so a live list keeps polling and its place when
 * you switch, and nothing is fetched twice. On a phone the open list takes the
 * whole height left, the same as a single list on any other tab.
 */
export function PairPanels({
  panels,
}: {
  panels: { key: string; label: string; content: React.ReactNode }[];
}) {
  const [active, setActive] = useState(panels[0]?.key ?? "");
  const pair = panels.length > 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {pair ? (
        <div
          role="tablist"
          aria-label="Lists"
          className="flex shrink-0 items-center gap-1 border-b border-border pb-1.5 lg:hidden"
        >
          {panels.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={p.key === active}
              onClick={() => setActive(p.key)}
              className={`rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                p.key === active
                  ? "bg-[var(--gata-card-hi)] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={`grid min-h-0 flex-1 gap-3 pt-2.5 lg:pt-0 ${pair ? "lg:grid-cols-2" : ""}`}
      >
        {panels.map((p) => (
          <section
            key={p.key}
            className={`min-h-0 flex-col gap-2 ${p.key === active ? "flex" : "hidden lg:flex"}`}
          >
            {/* Below lg the tab names the list; from lg the heading does. */}
            <h2
              className={`font-display shrink-0 text-[15px] font-semibold tracking-[-0.01em] ${
                pair ? "hidden lg:block" : ""
              }`}
            >
              {p.label}
            </h2>
            <div className="min-h-0 flex-1">{p.content}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
