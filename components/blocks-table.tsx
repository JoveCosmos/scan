"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { timeAgo, truncateMiddle } from "@/lib/format";
import type { NamedBlock } from "@/lib/blocks";
import { RowDeck, type DeckRow } from "@/components/row-deck";

/**
 * The block list.
 *
 * A deck rather than a table that grows: the page has a fixed height, so this
 * shows as many blocks as fit and pages the rest. Clicking a row opens the
 * block's record where it stands — the whole block page is still one link away
 * inside the popup, for the transactions and the header hashes.
 *
 * The ticker is separate from the poll on purpose. Blocks arrive every few
 * seconds but "12s ago" is wrong the moment it is painted, so the ages re-render
 * once a second without touching the network.
 */
function useSecondsTicker() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

export function BlocksTable({
  chainId,
  accent,
  initialBlocks,
}: {
  chainId: string;
  accent: string;
  initialBlocks: NamedBlock[];
}) {
  const { data, isError } = useQuery<{ blocks: NamedBlock[] }>({
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
  const [freshHeight, setFreshHeight] = useState<string | null>(null);

  useEffect(() => {
    if (topHeight && topHeight !== prevTop.current) {
      prevTop.current = topHeight;
      setFreshHeight(topHeight);
      const id = setTimeout(() => setFreshHeight(null), 700);
      return () => clearTimeout(id);
    }
  }, [topHeight]);

  const rows: DeckRow[] = blocks.map((block) => ({
    key: block.height,
    fresh: block.height === freshHeight,
    cells: [
      {
        v: Number(block.height).toLocaleString(),
        mono: true,
        tone: "accent",
        align: "right",
      },
      { v: timeAgo(block.time), dim: true, align: "right" },
      {
        v: String(block.txCount),
        mono: true,
        align: "right",
        dim: block.txCount === 0,
      },
      { v: block.proposerMoniker ?? truncateMiddle(block.proposer, 8, 6), dim: !block.proposerMoniker },
      { v: block.hash ? truncateMiddle(block.hash, 10, 6) : "—", mono: true, dim: true },
    ],
    detail: {
      title: `Block ${Number(block.height).toLocaleString()}`,
      sub: timeAgo(block.time),
      rows: [
        { label: "Height", value: Number(block.height).toLocaleString(), mono: true },
        { label: "Time", value: block.time, mono: true },
        { label: "Transactions", value: String(block.txCount), mono: true },
        {
          label: "Proposer",
          value: block.proposerMoniker ?? block.proposer,
          mono: !block.proposerMoniker,
          href: block.proposerOperator
            ? `/${chainId}/validators/${block.proposerOperator}`
            : undefined,
        },
        ...(block.hash ? [{ label: "Hash", value: block.hash, mono: true }] : []),
      ],
      action: {
        label: "Transactions and header hashes",
        href: `/${chainId}/blocks/${block.height}`,
      },
    },
  }));

  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Height", align: "right", width: "22%" },
        { label: "Age", align: "right", width: "16%" },
        { label: "Txs", align: "right", width: "12%" },
        { label: "Proposer", phoneHide: true },
        { label: "Hash", optional: true, width: "22%" },
      ]}
      rows={rows}
      empty={isError ? "Connection lost — retrying." : "No blocks yet."}
    />
  );
}
