"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo, truncateMiddle } from "@/lib/format";
import type { TxSummary } from "@/lib/txs";
import { TxAmount } from "@/components/tx-amount";
import { formatCoins, type DenomInfo } from "@/lib/coin";

interface TxsPayload {
  txs: TxSummary[];
  scannedBlocks: number;
  headHeight: string | null;
}

function useSecondsTicker() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

function StatusIcon({ code }: { code: number | null }) {
  if (code === null) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-muted-foreground"
        title="Node has transaction indexing disabled — only the hash is known"
      >
        <HelpCircle className="h-3.5 w-3.5" />
        <span className="text-xs">Unindexed</span>
      </span>
    );
  }
  if (code === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--gata-green)]">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="text-xs">Success</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[var(--gata-burn)]"
      title={`ABCI error code ${code}`}
    >
      <XCircle className="h-3.5 w-3.5" />
      <span className="text-xs">Failed</span>
    </span>
  );
}

function MessagePills({ tx }: { tx: TxSummary }) {
  if (tx.messages.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const [first, ...rest] = tx.messages;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span
        className="rounded-md border border-[var(--gata-border-hi)] bg-secondary/70 px-2 py-0.5 text-xs"
        title={first.typeUrl}
      >
        {first.label}
      </span>
      {rest.length > 0 ? (
        <span
          className="text-xs text-muted-foreground"
          title={rest.map((m) => m.label).join(", ")}
        >
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}

export function TxsTable({
  chainId,
  exponent,
  symbol,
  denom,
  denoms,
  initial,
}: {
  chainId: string;
  exponent: number;
  symbol: string;
  denom: string;
  /** Known denoms for fee formatting — a chain may pay fees in another token. */
  denoms: DenomInfo[];
  initial: TxsPayload;
}) {
  const { data, isError } = useQuery<TxsPayload>({
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

  const txs = data.txs;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {!isError ? (
              <span className="gata-live-dot absolute inline-flex h-full w-full rounded-full bg-[var(--gata-green)]" />
            ) : null}
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                isError ? "bg-[var(--gata-burn)]" : "bg-[var(--gata-green)]"
              )}
            />
          </span>
          {isError ? "Connection lost — retrying" : "Streaming"}
        </span>
        <span>
          scanned last {data.scannedBlocks} blocks
          {data.headHeight
            ? ` to #${Number(data.headHeight).toLocaleString()}`
            : null}
        </span>
      </div>

      {txs.length === 0 ? (
        <div className="gata-panel px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No transactions in the last {data.scannedBlocks} blocks.
          </p>
        </div>
      ) : (
        <div className="gata-panel overflow-x-auto">
          <table className="gata-table w-full text-sm sm:min-w-[820px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground">Hash</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Amount
                </th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Height
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Fee
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Age
                </th>
              </tr>
            </thead>
            <tbody>
              {txs.map((tx) => (
                <tr
                  key={tx.hash}
                  className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
                >
                  <td data-label="Hash" data-primary className="px-4 py-3">
                    <Link
                      href={`/${chainId}/txs/${encodeURIComponent(tx.hash)}`}
                      // -my-2 keeps the row height while giving a ~32px tap target.
                      className="-my-2 inline-block py-2 font-mono text-xs text-primary hover:underline"
                      title={tx.hash}
                    >
                      {truncateMiddle(tx.hash, 10, 8)}
                    </Link>
                  </td>
                  <td data-label="Type" className="px-4 py-3">
                    <MessagePills tx={tx} />
                  </td>
                  <td data-label="Amount" className="px-4 py-3 text-right">
                    <TxAmount
                      denom={denom}
                      exponent={exponent}
                      symbol={symbol}
                      transfer={tx.transfer}
                    />
                  </td>
                  <td data-label="Status" className="px-4 py-3">
                    <StatusIcon code={tx.code} />
                  </td>
                  <td data-label="Height" className="px-4 py-3 text-right">
                    <Link
                      href={`/${chainId}/blocks/${tx.height}`}
                      className="-my-2 inline-block py-2 font-mono text-xs text-muted-foreground hover:text-foreground"
                    >
                      {Number(tx.height).toLocaleString()}
                    </Link>
                  </td>
                  <td
                    data-label="Fee"
                    className="px-4 py-3 text-right font-mono text-xs"
                  >
                    {formatCoins(tx.fee, denoms)}
                  </td>
                  <td
                    data-label="Age"
                    className="px-4 py-3 text-right text-xs text-muted-foreground"
                  >
                    {timeAgo(tx.time)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
