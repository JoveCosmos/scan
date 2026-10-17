import type { DeckColumn, DeckRow } from "@/components/row-deck";
import type { AccountTransfer } from "@/lib/gno-tokens";
import type { TokenSummary } from "@/lib/gno-token-data";
import { tokenHref } from "@/lib/gno-tokens";
import { addressCell, type GnoNames } from "@/lib/gno-users";
import { formatUnits, timeAgo } from "@/lib/format";

/** A gno.land account's Token transfers tab. */
export const TOKEN_TRANSFER_COLUMNS: DeckColumn[] = [
  { label: "Token", width: "14%", phoneWidth: "24%" },
  { label: "Direction", width: "11%", phoneHide: true },
  { label: "Counterparty" },
  { label: "Amount", align: "right", width: "20%", phoneWidth: "40%" },
  { label: "Block", align: "right", width: "12%", optional: true },
  { label: "Age", align: "right", width: "11%", phoneHide: true },
];

/** Rows for one page: what moved, which way, with whom, from the account's side. */
export function tokenTransferRows(
  chainId: string,
  address: string,
  transfers: AccountTransfer[],
  tokens: Map<string, TokenSummary> | null,
  names: GnoNames | null,
  times: Map<string, string>,
  realms: Map<string, string> | null = null
): DeckRow[] {
  return transfers.map((t) => {
    const token = tokens?.get(t.token) ?? null;
    const symbol = token?.symbol ?? t.token.split(".").slice(-2, -1)[0] ?? t.token;
    const incoming = t.to === address;
    const direction = incoming ? (t.from ? "In" : "Mint") : t.to ? "Out" : "Burn";
    const other = incoming ? t.from : t.to;
    const amount = token ? formatUnits(t.amount, token.decimals) : t.amount;
    const when = times.get(t.txHash) ?? null;
    return {
      key: `${t.txHash}-${t.eventIndex}`,
      search: `${symbol} ${other} ${names?.byAddress.get(other) ?? ""} ${realms?.get(other) ?? ""}`,
      cells: [
        token ? { v: symbol, tone: "accent", href: tokenHref(chainId, token) } : { v: symbol, mono: true },
        { v: direction, tone: incoming ? "ok" : undefined, dim: !incoming },
        other ? addressCell(names, other, 8, 6, realms) : { v: "-", dim: true },
        { v: `${incoming ? "+" : "-"}${amount}`, mono: true, align: "right", tone: incoming ? "ok" : undefined },
        { v: t.height.toLocaleString(), mono: true, align: "right", href: `/${chainId}/blocks/${t.height}` },
        { v: when ? timeAgo(when) : "-", dim: true, align: "right" },
      ],
      detail: {
        title: `${direction} ${amount} ${symbol}`,
        rows: [],
        action: { label: "Transaction", href: `/${chainId}/txs/${t.txHash}` },
      },
    };
  });
}
