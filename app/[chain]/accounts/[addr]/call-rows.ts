import type { DeckColumn, DeckRow } from "@/components/row-deck";
import type { AccountCall } from "@/lib/gno-index";
import { packageHref, shortPath } from "@/lib/gno-packages";
import { timeAgo, truncateMiddle } from "@/lib/format";

/** A gno.land account's Calls tab: the realm calls and runs it made. */
export const ACCOUNT_CALL_COLUMNS: DeckColumn[] = [
  { label: "Realm" },
  { label: "Function", width: "22%", phoneWidth: "34%" },
  { label: "Status", width: "10%", phoneHide: true },
  { label: "Block", align: "right", width: "12%", optional: true },
  { label: "Age", align: "right", width: "11%", phoneHide: true },
];

export function accountCallRows(chainId: string, calls: AccountCall[]): DeckRow[] {
  return calls.map((c) => ({
    key: `${c.txHash}-${c.msgIndex}`,
    search: `${c.pkgPath ?? "run"} ${c.func}`,
    cells: [
      c.pkgPath
        ? { v: shortPath(c.pkgPath), mono: true, href: packageHref(chainId, c.pkgPath) }
        : { v: "Run", dim: true },
      { v: c.kind === "run" ? "-" : c.func, mono: true, tone: c.kind === "run" ? undefined : "accent" },
      { v: c.success ? "Success" : "Failed", tone: c.success ? "ok" : "bad" },
      { v: c.height.toLocaleString(), mono: true, align: "right", href: `/${chainId}/blocks/${c.height}` },
      { v: c.time ? timeAgo(c.time) : "-", dim: true, align: "right" },
    ],
    detail: {
      title: c.kind === "run" ? "Run" : c.func,
      sub: truncateMiddle(c.txHash, 10, 8),
      rows: (c.args ?? []).map((a, n) => ({ label: `Argument ${n + 1}`, value: a, mono: true })),
      action: { label: "Transaction", href: `/${chainId}/txs/${c.txHash}` },
    },
  }));
}
