"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AddressLink } from "@/components/address-link";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Popup, PopupRows } from "@/components/ui/popup";
import { filterDeckRows } from "@/lib/deck-filter";
import { ink } from "@/lib/utils";

/**
 * A list that fits the screen.
 *
 * The page has a fixed height, so a list cannot be however long it is. This
 * measures the space it was actually given and shows the number of rows that
 * fit in it — about eight on a phone, twenty on a monitor — rather than
 * guessing a page size that is wrong on both.
 *
 * Measured rather than fixed because a fixed count is the one thing guaranteed
 * to be wrong: it either leaves a monitor half empty or overflows a phone,
 * which is the failure the whole layout exists to avoid. Bricks are counted
 * instead of measured — a reflow that moves a tile under the cursor is worse
 * than a half-full row — but a table row is expected to move when the window
 * does, so measuring is safe here.
 *
 * Clicking a row opens its full record. That replaces the navigation the old
 * tables did: coming back from a detail page costs a load and loses your place,
 * and most of the time the question was one field deep.
 */

export interface DeckCell {
  v: string;
  mono?: boolean;
  dim?: boolean;
  align?: "right";
  tone?: "ok" | "bad" | "accent";
  /** Drawn as a proportion bar behind the cell, 0–1. */
  bar?: number;
  /** Renders the cell as a real link. */
  href?: string;
  /** An address: routed by lib/address-route, shown as `v`. */
  address?: string;
}

export interface DeckColumn {
  label: string;
  align?: "right";
  /** Dropped on narrow screens, in this order. */
  optional?: boolean;
  /** Hidden below sm even when `optional` peers survive. */
  phoneHide?: boolean;
  width?: string;
}

export interface DeckRow {
  key: string;
  /**
   * Extra text the deck's own filter should match, beyond what the cells show.
   * A truncated address is not searchable, so the row passes its full form here.
   */
  search?: string;
  cells: DeckCell[];
  /** Highlights the row — used for the block that just arrived. */
  fresh?: boolean;
  detail: {
    title: string;
    sub?: string;
    rows: {
      label: string;
      value: string;
      mono?: boolean;
      href?: string;
      address?: string;
    }[];
    action?: { label: string; href: string };
  };
}

const ROW_H = 35;
const HEAD_H = 28;

function CellValue({ cell, href }: { cell: DeckCell; href?: string }) {
  if (cell.address) {
    return <AddressLink address={cell.address} label={cell.v} />;
  }
  if (!href) return <>{cell.v}</>;
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className="underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
    >
      {cell.v}
    </Link>
  );
}

function cellColor(cell: DeckCell, accent: string) {
  if (cell.tone === "ok") return "var(--gata-green)";
  if (cell.tone === "bad") return "var(--destructive)";
  if (cell.tone === "accent") return ink(accent);
  return undefined;
}

export function RowDeck({
  columns,
  rows,
  accent,
  toolbar,
  empty = "Nothing to show.",
  filter,
  fit = false,
  footer,
}: {
  columns: DeckColumn[];
  rows: DeckRow[];
  accent: string;
  /** Filters and the like, drawn above the head and inside the measured area. */
  toolbar?: React.ReactNode;
  empty?: string;
  /**
   * Turns on the deck's own filter box. Kept here rather than asked of every
   * caller because most callers are server components and cannot hold the
   * query; a deck that pages its rows is also the thing that should narrow them.
   */
  filter?: { placeholder: string };
  /**
   * Live feeds — the newest blocks, the newest transactions — show as many of
   * the newest rows as fit the frame and never page: page two of a feed is
   * stale by the time you reach it.
   */
  fit?: boolean;
  /** Extra controls on the right of the card's footer, e.g. an "Older" link. */
  footer?: React.ReactNode;
}) {
  const router = useRouter();
  const [perPage, setPerPage] = useState(12);
  const [page, setPage] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // A callback ref rather than an effect: the list box can be replaced (a
  // parent switching branches as data arrives), and an observer fixed on the
  // first box would keep measuring a detached element at its first height.
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  const [fitCount, setFitCount] = useState<number | null>(null);
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    // Head and row heights are read from the rendered table in layout pixels,
    // the same units as clientHeight, so the count holds under the page zoom.
    const measure = () => {
      const head = el.querySelector("thead") as HTMLElement | null;
      const row = el.querySelector("tbody tr") as HTMLElement | null;
      const headH = head?.offsetHeight || HEAD_H;
      const rowH = row && row.offsetHeight > 8 ? row.offsetHeight : ROW_H;
      setPerPage(Math.max(3, Math.floor((el.clientHeight - headH) / rowH)));
      // Feeds count the rows that end inside the box, both edges read in the
      // same on-screen coordinates, so the page zoom cancels out.
      const bottom = el.getBoundingClientRect().bottom + 0.5;
      let whole = 0;
      el.querySelectorAll("tbody tr").forEach((r) => {
        if (r.getBoundingClientRect().bottom <= bottom) whole += 1;
      });
      setFitCount(whole);
    };
    measureRef.current = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  const matched = useMemo(() => filterDeckRows(rows, query), [rows, query]);

  const pages = fit ? 1 : Math.max(1, Math.ceil(matched.length / perPage));
  // A filter that shortens the list must not strand you on a page past its end.
  const current = Math.min(page, pages - 1);
  const shown = useMemo(
    () =>
      // A feed draws every row; those past the last whole one are hidden
      // (see measure), so the list never ends on a cut-off row.
      fit
        ? matched
        : matched.slice(current * perPage, current * perPage + perPage),
    [matched, current, perPage, fit],
  );
  const open = rows.find((r) => r.key === openKey) ?? null;

  // A feed row past the last one that fits whole is hidden, not removed, so
  // the box can grow back into it on the next resize.
  const cut = (index: number) => fit && fitCount !== null && index >= fitCount;

  // New rows arrive with every poll: recount which of them fit.
  useLayoutEffect(() => {
    if (fit) measureRef.current?.();
  }, [fit, shown]);

  // A row with a page of its own goes there directly; only rows without one
  // open the summary popup.
  const activate = (row: DeckRow) => {
    if (row.detail.action) router.push(row.detail.action.href);
    else setOpenKey(row.key);
  };

  return (
    <div className="flex h-full flex-col">
      {filter || toolbar ? (
        <div className="flex shrink-0 flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
          {filter ? (
            <div className="relative sm:max-w-xs sm:flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={filter.placeholder}
                aria-label={filter.placeholder}
                spellCheck={false}
                className="h-8 w-full rounded-lg border border-border bg-secondary/50 pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[var(--gata-border-hi)]"
              />
            </div>
          ) : null}
          {toolbar ? <div className="min-w-0">{toolbar}</div> : null}
        </div>
      ) : null}

      <div className="gata-surface flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden">
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="border-b border-border">
                {columns.map((col, i) => (
                  <th
                    key={i}
                    scope="col"
                    style={col.width ? { width: col.width } : undefined}
                    className={`h-7 px-2.5 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground ${
                      col.align === "right" ? "text-right" : ""
                    } ${col.optional ? "hidden lg:table-cell" : ""} ${
                      col.phoneHide ? "hidden sm:table-cell" : ""
                    }`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, index) => (
                <tr
                  key={row.key}
                  aria-hidden={cut(index) ? true : undefined}
                  onClick={() => activate(row)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate(row);
                    }
                  }}
                  className={`group/row cursor-pointer border-b border-border/40 outline-none last:border-0 hover:bg-[var(--gata-card-hi)] focus-visible:bg-[var(--gata-card-hi)] ${
                    row.fresh ? "gata-flash" : ""
                  } ${cut(index) ? "invisible" : ""}`}
                >
                  {row.cells.map((cell, i) => {
                    const col = columns[i];
                    return (
                      <td
                        key={i}
                        className={`h-[34px] truncate px-2.5 text-[13px] ${
                          cell.bar !== undefined ? "relative" : ""
                        } ${
                          // The affordance: the row's first cell is its link, so
                          // it underlines, and a bar lights on the leading edge.
                          i === 0
                            ? "group-hover/row:underline group-hover/row:decoration-current/40 group-hover/row:underline-offset-2 group-hover/row:shadow-[inset_2px_0_0_var(--gata-blue)] group-focus-visible/row:shadow-[inset_2px_0_0_var(--gata-blue)]"
                            : ""
                        } ${
                          cell.align === "right" ? "text-right" : ""
                        } ${cell.mono ? "font-mono" : ""} ${
                          cell.dim && !cell.tone ? "text-muted-foreground" : ""
                        } ${col?.optional ? "hidden lg:table-cell" : ""} ${
                          col?.phoneHide ? "hidden sm:table-cell" : ""
                        }`}
                        style={{ color: cellColor(cell, accent) }}
                      >
                        {cell.bar !== undefined ? (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-[6px] left-0 -z-10 rounded-r-sm opacity-20"
                            style={{
                              width: `${Math.max(0, Math.min(1, cell.bar)) * 100}%`,
                              background: accent,
                            }}
                          />
                        ) : null}
                        <CellValue
                          cell={cell}
                          // The row's own page, as a real link on its first cell,
                          // so it opens in a new tab like any link does.
                          href={
                            cell.href ??
                            (i === 0 ? row.detail.action?.href : undefined)
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {shown.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="h-24 px-2.5 text-center text-[13px] text-muted-foreground"
                  >
                    {query ? `Nothing matches "${query}".` : empty}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* The card's footer: where the list stands, and the way on. */}
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-[var(--gata-bg2)] px-3 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-2">
            {fit ? (
              <>
                <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
                <span>Live · latest {fitCount ?? shown.length}</span>
              </>
            ) : matched.length === 0 ? (
              query ? (
                `no match of ${rows.length}`
              ) : (
                "0"
              )
            ) : (
              `${current * perPage + 1}–${current * perPage + shown.length} of ${matched.length}`
            )}
          </span>
          <span className="flex items-center gap-2">
            {footer}
            {!fit && pages > 1 ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(0, current - 1))}
                  disabled={current === 0}
                  aria-label="Previous page"
                  className="rounded-md border border-border p-1 transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground disabled:opacity-35 disabled:hover:border-border"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="tabular-nums">
                  {current + 1}/{pages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(Math.min(pages - 1, current + 1))}
                  disabled={current >= pages - 1}
                  aria-label="Next page"
                  className="rounded-md border border-border p-1 transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground disabled:opacity-35 disabled:hover:border-border"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : null}
          </span>
        </div>
      </div>

      <Popup
        open={open !== null}
        onClose={() => setOpenKey(null)}
        title={open?.detail.title ?? ""}
        sub={open?.detail.sub}
        accent={accent}
      >
        {open ? <PopupRows rows={open.detail.rows} /> : null}
        {open?.detail.action ? (
          <a
            href={open.detail.action.href}
            className="mt-4 inline-flex text-sm text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
          >
            {open.detail.action.label} →
          </a>
        ) : null}
      </Popup>
    </div>
  );
}
