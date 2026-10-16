"use client";

import { useEffect, useState } from "react";
import { RowDeck, type DeckColumn, type DeckRow } from "@/components/row-deck";

/**
 * A deck whose rows are fetched when it is first drawn: for the tab of a page
 * that is not open on arrival (see SectionTabs, which draws a tab when it is
 * opened), so the page does not carry rows nobody may look at.
 */
export function LazyDeck({
  endpoint,
  columns,
  accent,
  filter,
  empty,
}: {
  /** Answers `{ rows: DeckRow[] }`. */
  endpoint: string;
  columns: DeckColumn[];
  accent: string;
  filter?: { placeholder: string };
  empty: string;
}) {
  const [rows, setRows] = useState<DeckRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(endpoint)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { rows: DeckRow[] }) => live && setRows(d.rows))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [endpoint]);

  return (
    <RowDeck
      accent={accent}
      columns={columns}
      rows={rows ?? []}
      filter={filter}
      empty={failed ? "N/A" : rows === null ? "Loading…" : empty}
    />
  );
}
