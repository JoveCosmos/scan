"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { timeAgo, truncateMiddle } from "@/lib/format";
import type { BlockSummary } from "@/lib/blocks";

function useSecondsTicker() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

export function BlocksTable({
  chainId,
  initialBlocks,
}: {
  chainId: string;
  initialBlocks: BlockSummary[];
}) {
  const { data, isError } = useQuery<{ blocks: BlockSummary[] }>({
    queryKey: ["blocks", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/chains/${chainId}/blocks`, { cache: "no-store" });
      if (!res.ok) throw new Error(`blocks request failed: ${res.status}`);
      return res.json();
    },
    initialData: { blocks: initialBlocks },
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });

  useSecondsTicker();

  const blocks = data.blocks;
  const topHeight = blocks[0]?.height;
  const prevTop = useRef(topHeight);
  const [flashHeight, setFlashHeight] = useState<string | null>(null);

  useEffect(() => {
    if (topHeight && topHeight !== prevTop.current) {
      prevTop.current = topHeight;
      setFlashHeight(topHeight);
      const id = setTimeout(() => setFlashHeight(null), 700);
      return () => clearTimeout(id);
    }
  }, [topHeight]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
        <span>{isError ? "Connection lost — retrying" : "Streaming new blocks"}</span>
      </div>

      <div className="gata-panel overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">Height</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Age</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Txs
              </th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Proposer</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">
                Block Hash
              </th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((block) => (
              <tr
                key={block.height}
                className={cn(
                  "border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60",
                  flashHeight === block.height && "gata-flash"
                )}
              >
                <td className="px-4 py-2.5 font-mono font-medium tabular-nums">
                  <Link
                    href={`/${chainId}/blocks/${block.height}`}
                    className="text-primary hover:underline"
                  >
                    {Number(block.height).toLocaleString()}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {timeAgo(block.time)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                  {block.txCount > 0 ? (
                    block.txCount
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td
                  className="px-4 py-2.5 font-mono text-xs text-muted-foreground"
                  title={block.proposer}
                >
                  {truncateMiddle(block.proposer, 8, 6)}
                </td>
                <td
                  className="px-4 py-2.5 font-mono text-xs text-muted-foreground"
                  title={block.hash ?? undefined}
                >
                  {block.hash ? truncateMiddle(block.hash, 10, 6) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
