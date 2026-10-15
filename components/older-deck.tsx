"use client";

import { useState } from "react";
import { RowDeck, type DeckColumn, type DeckRow } from "@/components/row-deck";

/**
 * A newest-first list with an "Older" control that appends the next page from
 * `endpoint?before=<cursor>`. The server builds the rows, so this only keeps
 * the cursor and asks for more (the account history works the same way).
 */
export function OlderDeck({
  endpoint,
  columns,
  initialRows,
  initialNext,
  accent,
  empty,
  extra,
  filter,
}: {
  endpoint: string;
  columns: DeckColumn[];
  initialRows: DeckRow[];
  initialNext: string | null;
  accent: string;
  empty: string;
  /** Chips shown beside the control. */
  extra?: React.ReactNode;
  /** The deck's own filter, over the rows loaded so far. */
  filter?: { placeholder: string };
}) {
  const [rows, setRows] = useState(initialRows);
  const [next, setNext] = useState(initialNext);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  async function loadOlder() {
    if (!next) return;
    setState("loading");
    try {
      const res = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}before=${encodeURIComponent(next)}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { rows: DeckRow[]; next: string | null };
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.key));
        return [...prev, ...body.rows.filter((r) => !seen.has(r.key))];
      });
      setNext(body.next);
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  const toolbar =
    extra || next ? (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-mono text-muted-foreground">{rows.length.toLocaleString("en-US")} shown</span>
        {extra}
        {next ? (
          <button
            type="button"
            onClick={loadOlder}
            disabled={state === "loading"}
            className="rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5 font-medium text-foreground transition-colors hover:border-[var(--gata-border-hi)] disabled:opacity-50"
          >
            {state === "loading" ? "Loading…" : state === "failed" ? "Retry older" : "Older"}
          </button>
        ) : null}
      </div>
    ) : undefined;

  return <RowDeck columns={columns} rows={rows} accent={accent} toolbar={toolbar} empty={empty} filter={filter} />;
}
