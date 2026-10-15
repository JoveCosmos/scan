import type { DeckColumn, DeckRow } from "@/components/row-deck";
import type { GnoCall } from "@/lib/gno-packages";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { addressCell, type GnoNames } from "@/lib/gno-users";

/** A realm's Calls tab: the page's first rows and each older page from the API. */
export const CALL_COLUMNS: DeckColumn[] = [
  { label: "Function", width: "24%" },
  { label: "Caller" },
  { label: "Status", width: "11%", phoneHide: true },
  { label: "Block", align: "right", width: "12%", optional: true },
  { label: "Age", align: "right", width: "12%" },
];

export function callRows(chainId: string, calls: GnoCall[], names: GnoNames | null = null): DeckRow[] {
  return calls.map((c, i) => ({
    key: `${c.txHash}-${c.func}-${i}`,
    search: `${c.func} ${c.caller} ${names?.byAddress.get(c.caller) ?? ""}`,
    cells: [
      { v: c.func, mono: true, tone: "accent" },
      addressCell(names, c.caller),
      { v: c.success ? "Success" : "Failed", tone: c.success ? "ok" : "bad" },
      { v: c.height.toLocaleString(), mono: true, align: "right", href: `/${chainId}/blocks/${c.height}` },
      { v: c.time ? timeAgo(c.time) : "-", dim: true, align: "right" },
    ],
    detail: {
      title: c.func,
      sub: truncateMiddle(c.txHash, 10, 8),
      rows: [],
      action: { label: "Transaction", href: `/${chainId}/txs/${c.txHash}` },
    },
  }));
}
