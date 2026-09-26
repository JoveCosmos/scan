"use client";

import { useState } from "react";
import { RowDeck, type DeckColumn, type DeckRow } from "@/components/row-deck";

/**
 * An account's history with an "Older" control that appends the next page.
 * Rows arrive fully built from the server, so the browser needs no chain
 * knowledge — it only keeps the cursor and asks for more.
 */
export function AccountHistory({
  chainId,
  address,
  kind,
  columns,
  initialRows,
  initialNext,
  facts,
  accent,
  empty,
}: {
  chainId: string;
  address: string;
  kind: string | null;
  columns: DeckColumn[];
  initialRows: DeckRow[];
  initialNext: string | null;
  /** Short chips beside the control: "Indexed since …", "Partial". */
  facts: string[];
  accent: string;
  empty: string;
}) {
  const [rows, setRows] = useState(initialRows);
  const [next, setNext] = useState(initialNext);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  async function loadOlder() {
    if (!next) return;
    setState("loading");
    try {
      const params = new URLSearchParams({ cursor: next });
      if (kind) params.set("kind", kind);
      const res = await fetch(`/${chainId}/accounts/${address}/txs?${params}`);
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
    facts.length > 0 || next ? (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-mono text-muted-foreground">{rows.length} shown</span>
        {facts.map((f) => (
          <span
            key={f}
            className="rounded-md border border-border bg-[var(--gata-card)] px-1.5 py-0.5 text-muted-foreground"
          >
            {f}
          </span>
        ))}
        {next ? (
          <button
            type="button"
            onClick={loadOlder}
            disabled={state === "loading"}
            className="rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5 font-medium text-foreground transition-colors hover:border-[var(--gata-border-hi)] disabled:opacity-50"
          >
            {state === "loading" ? "Loading…" : state === "failed" ? "Older · retry" : "Older"}
          </button>
        ) : null}
      </div>
    ) : undefined;

  return <RowDeck columns={columns} rows={rows} accent={accent} toolbar={toolbar} empty={empty} />;
}
