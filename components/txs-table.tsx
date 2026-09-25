"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { formatCoins, type DenomInfo } from "@/lib/coin";
import type { RecentTxs } from "@/lib/adapter";
import { RowDeck, type DeckRow } from "@/components/row-deck";

/**
 * The transaction list.
 *
 * Same deck as blocks: as many rows as fit, the rest paged, and the record in a
 * popup rather than a page away. A transaction is the clearest case for it —
 * most visits ask one question ("did it land, and what did it move?") that the
 * popup answers outright.
 */
function useSecondsTicker() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

export function TxsTable({
  chainId,
  accent,
  denoms,
  initial,
}: {
  chainId: string;
  accent: string;
  /** Known denoms for fee formatting — a chain may pay fees in another token. */
  denoms: DenomInfo[];
  initial: RecentTxs;
}) {
  const { data, isError } = useQuery<RecentTxs>({
    queryKey: ["txs", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/chains/${chainId}/txs`, { cache: "no-store" });
      if (!res.ok) throw new Error(`txs request failed: ${res.status}`);
      return res.json();
    },
    initialData: initial,
    refetchInterval: 6000,
    refetchIntervalInBackground: false,
  });

  useSecondsTicker();

  const rows: DeckRow[] = data.txs.map((tx) => {
    const ok = tx.code === 0;
    const amount =
      tx.transfer && tx.transfer.amount.length > 0
        ? formatCoins(tx.transfer.amount, denoms, 2)
        : "—";
    const type =
      tx.messages[0]?.label ??
      (tx.messageCount > 1 ? `${tx.messageCount} messages` : "—");

    return {
      key: tx.hash,
      cells: [
        { v: truncateMiddle(tx.hash, 10, 6), mono: true, tone: "accent" },
        { v: type },
        { v: amount, mono: true, align: "right" },
        {
          v: tx.code === null ? "—" : ok ? "ok" : `fail ${tx.code}`,
          mono: true,
          tone: tx.code === null ? undefined : ok ? "ok" : "bad",
        },
        {
          v: Number(tx.height).toLocaleString(),
          mono: true,
          dim: true,
          align: "right",
        },
        { v: timeAgo(tx.time), dim: true, align: "right" },
      ],
      detail: {
        title: truncateMiddle(tx.hash, 12, 8),
        sub: type,
        rows: [
          { label: "Hash", value: tx.hash, mono: true },
          {
            label: "Status",
            value: tx.code === null ? "—" : ok ? "success" : `failed (code ${tx.code})`,
          },
          {
            label: "Height",
            value: Number(tx.height).toLocaleString(),
            mono: true,
            href: `/${chainId}/blocks/${tx.height}`,
          },
          ...(tx.time ? [{ label: "Time", value: tx.time, mono: true }] : []),
          { label: "Messages", value: String(tx.messageCount), mono: true },
          ...(tx.messages.length > 0
            ? [
                {
                  label: "Types",
                  value: tx.messages.map((m) => m.label).join(", "),
                },
              ]
            : []),
          ...(amount !== "—" ? [{ label: "Amount", value: amount, mono: true }] : []),
          ...(tx.transfer?.from
            ? [
                {
                  label: "From",
                  value: truncateMiddle(tx.transfer.from, 14, 8),
                  mono: true,
                  href: `/${chainId}/accounts/${tx.transfer.from}`,
                },
              ]
            : []),
          ...(tx.transfer?.to
            ? [
                {
                  label: "To",
                  value: truncateMiddle(tx.transfer.to, 14, 8),
                  mono: true,
                  href: tx.transfer.to.includes("valoper")
                    ? `/${chainId}/validators/${tx.transfer.to}`
                    : `/${chainId}/accounts/${tx.transfer.to}`,
                },
              ]
            : []),
          { label: "Fee", value: formatCoins(tx.fee, denoms), mono: true },
          ...(tx.memo ? [{ label: "Memo", value: tx.memo }] : []),
        ],
        action: {
          label: "Full transaction and messages",
          href: `/${chainId}/txs/${encodeURIComponent(tx.hash)}`,
        },
      },
    };
  });

  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Hash", width: "22%" },
        { label: "Type" },
        { label: "Amount", align: "right", phoneHide: true },
        { label: "Status", width: "12%" },
        { label: "Height", align: "right", optional: true, width: "14%" },
        { label: "Age", align: "right", phoneHide: true, width: "12%" },
      ]}
      rows={rows}
      limit={10}
      empty={
        isError
          ? "Connection lost — retrying."
          : "No transactions in the blocks scanned."
      }
    />
  );
}
