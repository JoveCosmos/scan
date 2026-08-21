"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * The detail layer.
 *
 * With the app scroll-free, a page can only show what fits — so the depth that
 * used to live further down a long page lives in here instead. Clicking a brick
 * or a row opens the whole record without leaving the page that gave it
 * context, which is also why this is a popup and not a route: coming back from
 * a route costs a navigation and loses your place in the list.
 *
 * The body is the one thing in the app allowed to scroll, because a popup that
 * clipped a raw log would be hiding the thing it was opened to show.
 */
export function Popup({
  open,
  onClose,
  title,
  sub,
  accent,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  accent?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus was before we took it, so closing puts it back on the brick
  // that opened this rather than at the top of the document.
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    panelRef.current?.focus();

    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onEsc);

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onEsc);
      document.body.style.overflow = previous;
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
      />

      {/*
        A sheet on a phone and a centred panel above sm. Same markup: a phone
        has no room for margins on four sides, and a sheet puts the close
        control and the content within reach of a thumb.
      */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="gata-panel relative flex max-h-[85dvh] w-full flex-col rounded-b-none sm:max-h-[80dvh] sm:max-w-lg sm:rounded-b-xl"
        style={accent ? ({ ["--panel-accent" as string]: accent } as React.CSSProperties) : undefined}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
            {sub ? (
              <p className="truncate font-mono text-[11px] text-muted-foreground">{sub}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>
  );
}

/** Label/value rows, the popup's standard body. */
export function PopupRows({
  rows,
}: {
  rows: { label: string; value: React.ReactNode; mono?: boolean }[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 sm:grid-cols-[minmax(7rem,auto)_1fr]">
      {rows.map((row, i) => (
        <div
          key={`${row.label}-${i}`}
          className="contents"
        >
          <dt className="pt-2 text-[11px] uppercase tracking-[0.1em] text-muted-foreground sm:py-2">
            {row.label}
          </dt>
          <dd
            className={`min-w-0 break-all border-b border-border/40 pb-2 last:border-0 sm:py-2 ${
              row.mono ? "font-mono text-[13px]" : "text-sm"
            }`}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
