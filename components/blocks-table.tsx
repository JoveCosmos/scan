"use client";

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
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              isError ? "bg-red-500" : "bg-emerald-500"
            )}
          />
        </span>
        <span>{isError ? "Connection lost — retrying" : "Streaming new blocks"}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-medium">Height</th>
              <th className="px-4 py-2.5 font-medium">Age</th>
              <th className="px-4 py-2.5 text-right font-medium">Txs</th>
              <th className="px-4 py-2.5 font-medium">Proposer</th>
              <th className="px-4 py-2.5 font-medium">Block Hash</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((block) => (
              <tr
                key={block.height}
                className={cn(
                  "border-b border-border/60 transition-colors duration-500 last:border-0",
                  flashHeight === block.height ? "bg-primary/10" : "hover:bg-muted/30"
                )}
              >
                <td className="px-4 py-2.5 font-mono tabular-nums font-medium">
                  {Number(block.height).toLocaleString()}
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
