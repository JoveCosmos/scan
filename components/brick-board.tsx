"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { ChainOverview } from "@/lib/overview";
import { timeAgo } from "@/lib/format";
import { Brick, BrickButton, BrickGrid, BrickLink, type BrickVisual } from "@/components/brick";
import { Popup, PopupRows } from "@/components/ui/popup";
import { Prose } from "@/components/prose";

/**
 * A page laid out in bricks, with the detail in popups.
 *
 * Everything is computed on the server and arrives as data — this component
 * knows nothing about chains, params or governance, which is why the same board
 * renders the overview, the infra tab and anything added later.
 *
 * Three bricks are marked `live` and re-read from the head poll. Only those
 * three change, so the rest of the board never re-renders against the network.
 */

export interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
  /** Renders the value as a link. External links open in a new tab. */
  href?: string;
  /** An address, routed to its own page and chain. */
  address?: string;
}

export interface BrickSpec extends BrickVisual {
  key: string;
  /** Rows shown when the brick is opened. Without rows or a body it is inert. */
  rows?: DetailRow[];
  /**
   * Prose shown above the rows — a proposal's summary, an operator's own
   * description. Kept separate from a row because it is paragraphs rather than
   * a value, and reads as neither a label nor a figure.
   */
  body?: string;
  /** Navigates instead of opening — for detail that is a whole page. */
  href?: string;
  /** Re-read from the live head poll rather than the server render. */
  live?: "height" | "txCount" | "blockTime";
  /** With a live height: the link follows it to the block being shown. */
  liveHref?: "block";
  /** Offered at the foot of the popup. */
  action?: { label: string; href: string };
}

export function BrickBoard({
  chainId,
  accent,
  bricks,
  head,
  className,
  size = "sm",
  bare = false,
}: {
  /** Only needed for the live head poll, so a static board can omit it. */
  chainId?: string;
  accent: string;
  bricks: BrickSpec[];
  /**
   * Server-rendered head, so the live bricks have no loading state. Omit it on
   * a board with nothing live — a block that has already been produced does not
   * change, and polling it would be a request per page for no new information.
   */
  head?: ChainOverview;
  className?: string;
  /** "lg" is the overview's headline figures: fewer, larger tiles. */
  size?: "sm" | "lg";
  /** Tiles only, no grid of their own: the parent's grid places them, so two
   *  boards (one streamed in later) can share one row of tiles. */
  bare?: boolean;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const { data } = useQuery<ChainOverview>({
    queryKey: ["chain-head", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/chains/${chainId}/head`, { cache: "no-store" });
      if (!res.ok) throw new Error("head unavailable");
      return res.json();
    },
    initialData: head,
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
    enabled: head !== undefined && chainId !== undefined,
  });

  function resolve(brick: BrickSpec): BrickVisual {
    if (!brick.live || !data) return brick;
    if (brick.live === "height") {
      return {
        ...brick,
        value: data.height ? Number(data.height).toLocaleString() : "—",
        sub: timeAgo(data.blockTime),
      };
    }
    if (brick.live === "txCount") {
      return { ...brick, value: data.txCount === null ? "—" : String(data.txCount) };
    }
    return { ...brick, value: data.blockTime ? timeAgo(data.blockTime) : "—" };
  }

  const open = bricks.find((b) => b.key === openKey) ?? null;

  const tiles = bricks.map((brick) => {
    const visual = resolve(brick);
    const href =
      brick.liveHref === "block" && data?.height && chainId
        ? `/${chainId}/blocks/${data.height}`
        : brick.href;
    if (href) {
      return <BrickLink key={brick.key} brick={visual} accent={accent} href={href} />;
    }
    if ((brick.rows && brick.rows.length > 0) || brick.body) {
      return (
        <BrickButton
          key={brick.key}
          brick={visual}
          accent={accent}
          onClick={() => setOpenKey(brick.key)}
        />
      );
    }
    return <Brick key={brick.key} brick={visual} accent={accent} />;
  });

  return (
    <>
      {bare ? (
        tiles
      ) : (
        <BrickGrid
          className={`${size === "lg" ? "brick-lg !grid-cols-2 sm:!grid-cols-3 lg:!grid-cols-5" : ""} ${className ?? ""}`}
        >
          {tiles}
        </BrickGrid>
      )}

      <Popup
        open={open !== null}
        onClose={() => setOpenKey(null)}
        title={open?.label ?? ""}
        sub={open ? resolve(open).value : undefined}
        accent={accent}
      >
        {open?.body ? (
          <div className="mb-3">
            <Prose text={open.body} />
          </div>
        ) : null}
        {open?.rows ? (
          <PopupRows rows={open.rows} />
        ) : null}
        {open?.action ? (
          <Link
            href={open.action.href}
            onClick={() => setOpenKey(null)}
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
          >
            {open.action.label} →
          </Link>
        ) : null}
      </Popup>
    </>
  );
}
