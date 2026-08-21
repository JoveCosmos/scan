/**
 * Narrowing a deck to what you are looking for.
 *
 * One filter for every list in the app, rather than one written per page. The
 * decks are rendered by server components, which cannot hold a query, so the
 * deck owns both the box and the matching — and since a deck already decides
 * which rows you can see, narrowing them belongs in the same place.
 *
 * Matched against what the row *shows*, plus whatever it declares separately.
 * That second part matters: a deck truncates addresses to fit, and an address
 * you cannot find by pasting it in is an address the filter has failed.
 */

export interface Filterable {
  cells: { v: string }[];
  /** Full-length values the cells only show truncated. */
  search?: string;
}

export function filterDeckRows<T extends Filterable>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    `${row.cells.map((c) => c.v).join(" ")} ${row.search ?? ""}`
      .toLowerCase()
      .includes(q)
  );
}
