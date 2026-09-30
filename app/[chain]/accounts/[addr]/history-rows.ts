import type { ChainConfig } from "@/lib/chains";
import { chainDenoms } from "@/lib/chains";
import type { DenomInfo } from "@/lib/coin";
import { formatCoin, formatCoins } from "@/lib/coin";
import { timeAgo, truncateMiddle } from "@/lib/format";
import type { TxSummary } from "@/lib/txs";
import { directionFor, transferForAddress, type AddressMovement } from "@/lib/tx-parties";
import type { DeckRow } from "@/components/row-deck";

/**
 * An account's transaction history as deck rows, built on the server so the
 * "Older" button can append pages without the browser knowing any chain.
 */

/** What this transaction moved for this address, not for its first party. */
export function movementFor(tx: TxSummary, address: string): AddressMovement | null {
  const own = transferForAddress(tx.messages, address);
  if (own) return own;
  // Indexed rows carry only the transfer this account was party to.
  const dir = directionFor(tx.transfer, address);
  if (!tx.transfer || !dir) return null;
  return {
    direction: dir,
    counterparty: dir === "out" ? tx.transfer.to : dir === "in" ? tx.transfer.from : null,
    amount: tx.transfer.amount,
  };
}

/**
 * Signed rather than arrowed: the page is about one address, so "−12 ATONE"
 * says it in one glance. A dust amount is named as small instead of rounded to
 * a zero that is not true.
 */
function signedAmount(movement: AddressMovement | null, denoms: DenomInfo[]): string {
  if (!movement || movement.amount.length === 0) return "—";
  const sign = movement.direction === "out" ? "−" : movement.direction === "in" ? "+" : "";
  const text = movement.amount
    .map((coin) => {
      const formatted = formatCoin(coin, denoms, 4);
      const dust =
        formatted.startsWith("0.0000") && /^\d+$/.test(coin.amount) && coin.amount !== "0";
      return dust ? formatted.replace("0.0000", "<0.0001") : formatted;
    })
    .join(", ");
  return `${sign}${text}`;
}

export function buildHistoryRows(
  chain: ChainConfig,
  address: string,
  txs: TxSummary[],
  /** Adds the Role cell, for histories the index's tx_party answered. */
  withRoles = false
): DeckRow[] {
  const denoms = chainDenoms(chain);

  return txs.map((tx) => {
    const movement = movementFor(tx, address);
    const other = movement?.counterparty ?? null;
    const status =
      tx.code === null ? "unindexed" : tx.code === 0 ? "success" : `failed ${tx.code}`;
    const label = tx.messages[0]?.label ?? "—";
    const amount = signedAmount(movement, denoms);

    return {
      key: tx.hash,
      cells: [
        { v: truncateMiddle(tx.hash, 8, 6), mono: true, tone: "accent" as const },
        { v: tx.messages.length > 1 ? `${label} +${tx.messages.length - 1}` : label },
        ...(withRoles
          ? [
              tx.roles && tx.roles.length > 0
                ? { v: tx.roles.join(", ") }
                : { v: "—", dim: true },
            ]
          : []),
        movement?.direction === "self"
          ? { v: "self", dim: true }
          : other
            ? {
                v: `${movement?.direction === "out" ? "to" : "from"} ${truncateMiddle(other, 10, 6)}`,
                mono: true,
                address: other,
              }
            : { v: "—", dim: true },
        {
          v: amount,
          mono: true,
          align: "right" as const,
          tone:
            movement?.direction === "out"
              ? ("bad" as const)
              : movement?.direction === "in"
                ? ("ok" as const)
                : undefined,
        },
        {
          v: status,
          dim: tx.code === null,
          tone: tx.code === null ? undefined : tx.code === 0 ? ("ok" as const) : ("bad" as const),
        },
        {
          v: Number(tx.height).toLocaleString(),
          mono: true,
          dim: true,
          align: "right" as const,
          href: `/${chain.chainId}/blocks/${tx.height}`,
        },
        { v: formatCoins(tx.fee, denoms), mono: true, dim: true, align: "right" as const },
        { v: timeAgo(tx.time), dim: true, align: "right" as const },
      ],
      detail: {
        title: label,
        sub: tx.hash,
        rows: [
          { label: "Hash", value: tx.hash, mono: true },
          { label: "Amount", value: amount, mono: true },
          ...(other ? [{ label: "Counterparty", value: other, mono: true, address: other }] : []),
        ],
        action: {
          label: "Full transaction",
          href: `/${chain.chainId}/txs/${encodeURIComponent(tx.hash)}`,
        },
      },
    };
  });
}
