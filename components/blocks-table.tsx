"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base64ToHex, timeAgo, truncateMiddle } from "@/lib/format";
import type { NamedBlock } from "@/lib/blocks";
import { RowDeck, type DeckRow } from "@/components/row-deck";

/**
 * The block list.
 *
 * A deck rather than a table that grows: the page has a fixed height, so this
 * shows as many blocks as fit. The height is a real link to the block and the
 * proposer a real link to its validator. Live, it polls the head; on an
 * "Older" page (`live` false) it shows a fixed window and never polls.
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
  live = true,
  footer,
}: {
  chainId: string;
  accent: string;
  initialBlocks: NamedBlock[];
  /** Poll the head. Off on the older pages, which are fixed windows. */
  live?: boolean;
  /** Paging controls, shown in the list card's footer bar. */
  footer?: React.ReactNode;
}) {
  const { data, isError } = useQuery<{ blocks: NamedBlock[] }>({
    // An older page is its own entry: sharing the live key would hand it the
    // live feed from the cache.
    queryKey: ["blocks", chainId, live ? "live" : initialBlocks[0]?.height],
    queryFn: async () => {
      const res = await fetch(`/api/chains/${chainId}/blocks`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`blocks request failed: ${res.status}`);
      return res.json();
    },
    initialData: { blocks: initialBlocks },
    refetchInterval: live ? 3000 : false,
    enabled: live,
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

  const rows: DeckRow[] = blocks.map((block) => {
    const href = `/${chainId}/blocks/${block.height}`;
    // A resolved proposer links to its validator. An unresolved one is either
    // a raw address (truncated) or, on gno, a name already — shown whole.
    const raw = block.proposer;
    const looksLikeAddress =
      /^[A-Za-z0-9+/=]{24,}$/.test(raw) || /^g1[0-9a-z]{30,}$/.test(raw);
    const hash = base64ToHex(block.hash);
    return {
      key: block.height,
      fresh: block.height === freshHeight,
      cells: [
        {
          v: Number(block.height).toLocaleString(),
          mono: true,
          tone: "accent",
          align: "right",
          href,
        },
        { v: timeAgo(block.time), dim: true, align: "right" },
        {
          v: String(block.txCount),
          mono: true,
          align: "right",
          dim: block.txCount === 0,
        },
        block.proposerMoniker && block.proposerOperator
          ? {
              v: block.proposerMoniker,
              href: `/${chainId}/validators/${block.proposerOperator}`,
              avatar: {
                name: block.proposerMoniker,
                logos: (block as { proposerLogos?: string[] }).proposerLogos ?? [],
              },
            }
          : {
              v: looksLikeAddress ? truncateMiddle(raw, 8, 6) : raw,
              dim: looksLikeAddress,
            },
        { v: hash ? truncateMiddle(hash, 10, 6) : "—", mono: true, dim: true },
      ],
      detail: {
        title: `Block ${Number(block.height).toLocaleString()}`,
        rows: [],
        action: { label: "Block", href },
      },
    };
  });

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
      fit
      live={live}
      footer={footer}
      empty={isError ? "Connection lost — retrying." : "No blocks yet."}
    />
  );
}
