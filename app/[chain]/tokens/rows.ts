import type { DeckColumn, DeckRow } from "@/components/row-deck";
import type { RankedHolder, TokenSummary } from "@/lib/gno-token-data";
import type { TokenTransfer } from "@/lib/gno-tokens";
import { addressCell, type GnoNames } from "@/lib/gno-users";
import { formatToken } from "@/lib/overview";
import { timeAgo, truncateMiddle } from "@/lib/format";

/**
 * A token's Holders and Transfers tabs: the page's first rows and each older
 * page from the API, built the same way.
 */

export const HOLDER_COLUMNS: DeckColumn[] = [
  { label: "#", align: "right", width: "8%", phoneWidth: "12%" },
  { label: "Holder" },
  { label: "Balance", align: "right", width: "24%", phoneWidth: "34%" },
  { label: "Share", align: "right", width: "12%", phoneHide: true },
];

export const TRANSFER_COLUMNS: DeckColumn[] = [
  { label: "From" },
  { label: "To" },
  { label: "Amount", align: "right", width: "18%" },
  { label: "Block", align: "right", width: "12%", optional: true },
  { label: "Age", align: "right", width: "12%", phoneHide: true },
];

/** "42.13%" of the supply, and the same as a 0-1 bar. */
function shareOf(token: TokenSummary, part: bigint): { text: string; bar: number } {
  if (token.supply <= BigInt(0)) return { text: "-", bar: 0 };
  const ppm = Number((part * BigInt(1_000_000)) / token.supply);
  return { text: `${(ppm / 10_000).toFixed(2)}%`, bar: Math.min(1, ppm / 1_000_000) };
}

export function holderRows(
  chainId: string,
  token: TokenSummary,
  holders: RankedHolder[],
  names: GnoNames | null,
  realms: Map<string, string> | null
): DeckRow[] {
  return holders.map((h) => {
    const share = shareOf(token, h.balance);
    return {
      key: h.address,
      search: `${h.address} ${names?.byAddress.get(h.address) ?? ""} ${realms?.get(h.address) ?? ""}`,
      cells: [
        { v: String(h.rank), mono: true, dim: true, align: "right" },
        addressCell(names, h.address, 12, 8, realms),
        { v: formatToken(h.balance.toString(), token.decimals), mono: true, align: "right", bar: share.bar },
        { v: share.text, mono: true, align: "right" },
      ],
      detail: {
        title: truncateMiddle(h.address, 14, 8),
        rows: [],
        action: { label: "Account", href: `/${chainId}/accounts/${h.address}` },
      },
    };
  });
}

export function transferRows(
  chainId: string,
  token: TokenSummary,
  transfers: TokenTransfer[],
  names: GnoNames | null,
  realms: Map<string, string> | null,
  times: Map<string, string>
): DeckRow[] {
  const amount = (v: bigint) => formatToken(v.toString(), token.decimals);
  const party = (a: string, none: string): DeckRow["cells"][number] =>
    a ? addressCell(names, a, 8, 6, realms) : { v: none, tone: "accent" };
  return transfers.map((t) => {
    const when = times.get(t.txHash) ?? null;
    return {
      key: `${t.txHash}-${t.eventIndex}`,
      search: [t.from, t.to].map((a) => `${a} ${names?.byAddress.get(a) ?? ""} ${realms?.get(a) ?? ""}`).join(" "),
      cells: [
        party(t.from, "Mint"),
        party(t.to, "Burn"),
        { v: amount(t.amount), mono: true, align: "right" },
        { v: t.height.toLocaleString(), mono: true, align: "right", href: `/${chainId}/blocks/${t.height}` },
        { v: when ? timeAgo(when) : "-", dim: true, align: "right" },
      ],
      detail: {
        title: `${amount(t.amount)} ${token.symbol}`,
        rows: [],
        action: { label: "Transaction", href: `/${chainId}/txs/${t.txHash}` },
      },
    };
  });
}
