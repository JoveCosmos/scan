"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { formatCoinsShort, type DenomInfo } from "@/lib/coin";
import type { RecentTxs } from "@/lib/adapter";
import { RowDeck, type DeckRow } from "@/components/row-deck";

/**
 * The transaction list: the newest transactions, as many as fit.
 *
 * Each row names the message that matters (a relayer's client update is never
 * it), counts the rest as "+N", and shows the amount that message moved. The
 * hash is a real link to the transaction.
 */
function useSecondsTicker() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

type Feed = RecentTxs & { denoms?: DenomInfo[] };

export function TxsTable({
  chainId,
  accent,
  denoms,
  initial,
}: {
  chainId: string;
  accent: string;
  /** Known denoms, including resolved IBC tokens — a fee may be in another token. */
  denoms: DenomInfo[];
  initial: Feed;
}) {
  const { data, isError } = useQuery<Feed>({
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
  const known = [...denoms, ...(data.denoms ?? [])];

  const rows: DeckRow[] = data.txs.map((tx) => {
    const ok = tx.code === 0;
    const type =
      tx.primaryLabel ??
      (tx.messages[0]
        ? tx.messageCount > 1
          ? `${tx.messages[0].label} +${tx.messageCount - 1}`
          : tx.messages[0].label
        : "—");
    const href = `/${chainId}/txs/${encodeURIComponent(tx.hash)}`;

    return {
      key: tx.hash,
      cells: [
        { v: truncateMiddle(tx.hash, 10, 6), mono: true, tone: "accent" },
        { v: type },
        {
          v: tx.transfer && tx.transfer.amount.length > 0 ? formatCoinsShort(tx.transfer.amount, known) : "—",
          mono: true,
          align: "right",
          dim: !tx.transfer?.amount.length,
        },
        { v: formatCoinsShort(tx.fee, known, 6), mono: true, align: "right", dim: true },
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
          href: `/${chainId}/blocks/${tx.height}`,
        },
        { v: timeAgo(tx.time), dim: true, align: "right" },
      ],
      detail: {
        title: truncateMiddle(tx.hash, 12, 8),
        sub: type,
        rows: [],
        action: { label: "Transaction", href },
      },
    };
  });

  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Hash", width: "18%" },
        { label: "Type" },
        { label: "Amount", align: "right", phoneHide: true, width: "17%" },
        { label: "Fee", align: "right", optional: true, width: "12%" },
        { label: "Status", width: "9%" },
        { label: "Height", align: "right", optional: true, width: "12%" },
        { label: "Age", align: "right", phoneHide: true, width: "9%" },
      ]}
      rows={rows}
      fit
      empty={isError || data.stale ? "N/A" : "No transactions"}
    />
  );
}
