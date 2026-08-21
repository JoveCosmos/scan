import { describe, expect, it } from "vitest";
import { filterDeckRows, type Filterable } from "@/lib/deck-filter";

const row = (cells: string[], search?: string): Filterable => ({
  cells: cells.map((v) => ({ v })),
  ...(search ? { search } : {}),
});

describe("filterDeckRows", () => {
  const rows = [
    row(["Forbole", "atone1q9x…4m2p", "yes"], "atone1q9xabcdef4m2p"),
    row(["Provalidator", "atone1z7k…8vn1", "no"], "atone1z7kabcdef8vn1"),
    row(["0base.vc", "atone1aaa…9zzz", "abstain"], "atone1aaabbbccc9zzz"),
  ];

  it("returns everything for an empty query", () => {
    expect(filterDeckRows(rows, "")).toHaveLength(3);
    expect(filterDeckRows(rows, "   ")).toHaveLength(3);
  });

  it("matches what the row shows", () => {
    expect(filterDeckRows(rows, "forbole")).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    expect(filterDeckRows(rows, "FORBOLE")).toHaveLength(1);
    expect(filterDeckRows(rows, "0BASE")).toHaveLength(1);
  });

  it("matches a full address the cell only shows truncated", () => {
    // The point of the `search` field. Pasting in an address you already have
    // is the main way anyone looks for a specific row, and the visible cell is
    // an ellipsis in the middle of exactly the part being pasted.
    expect(filterDeckRows(rows, "atone1z7kabcdef8vn1")).toHaveLength(1);
  });

  it("still matches the truncated form that is on screen", () => {
    expect(filterDeckRows(rows, "atone1q9x")).toHaveLength(1);
  });

  it("matches across columns, not only the first", () => {
    expect(filterDeckRows(rows, "abstain")).toHaveLength(1);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterDeckRows(rows, "cosmostation")).toHaveLength(0);
  });

  it("does not match across a column boundary", () => {
    // Cells are joined with a space, so "Forbole" and the address next to it
    // are separate words — a query spanning both should not hit.
    expect(filterDeckRows(rows, "Forboleatone")).toHaveLength(0);
  });

  it("copes with a row that declares no extra search text", () => {
    expect(filterDeckRows([row(["plain"])], "plain")).toHaveLength(1);
  });
});
