"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { BrickButton, BrickGrid } from "@/components/brick";
import { Popup, PopupRows } from "@/components/ui/popup";

/**
 * Proposals as bricks, one per proposal, numbered.
 *
 * A governance list is the clearest case for this layout: the identity of a
 * proposal is its number and its title, and everything else — tally, dates,
 * deposit, proposer — is detail you want for exactly one of them at a time.
 * As stacked rows that detail either bloated every row or forced a navigation.
 *
 * Paged rather than scrolled, because the page has a fixed height. The page
 * size is a count, not a measurement: measuring the viewport and reflowing
 * would move bricks under the cursor on every resize.
 */

export interface ProposalBrick {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  tone?: "ok" | "bad";
  expedited: boolean;
  sub: string;
  rows: { label: string; value: string; mono?: boolean }[];
}

const PER_PAGE = 12;

export function ProposalBoard({
  chainId,
  accent,
  proposals,
}: {
  chainId: string;
  accent: string;
  proposals: ProposalBrick[];
}) {
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const pages = Math.max(1, Math.ceil(proposals.length / PER_PAGE));
  const shown = proposals.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const open = proposals.find((p) => p.id === openId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <BrickGrid>
          {shown.map((proposal) => (
            <BrickButton
              key={proposal.id}
              accent={accent}
              brick={{
                label: `#${proposal.id}${proposal.expedited ? " · expedited" : ""}`,
                value: proposal.title,
                text: true,
                sub: proposal.sub,
                tone: proposal.tone,
              }}
              onClick={() => setOpenId(proposal.id)}
            />
          ))}
        </BrickGrid>
      </div>

      {pages > 1 ? (
        <div className="mt-3 flex shrink-0 items-center justify-between gap-3 border-t border-border pt-2.5 font-mono text-[11px] text-muted-foreground">
          <span>
            {page * PER_PAGE + 1}–{page * PER_PAGE + shown.length} of {proposals.length}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
              className="rounded-md border border-border p-1 transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground disabled:opacity-35 disabled:hover:border-border"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              aria-label="Next page"
              className="rounded-md border border-border p-1 transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground disabled:opacity-35 disabled:hover:border-border"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      ) : null}

      <Popup
        open={open !== null}
        onClose={() => setOpenId(null)}
        title={open ? `#${open.id}` : ""}
        sub={open?.statusLabel}
        accent={accent}
      >
        {open ? (
          <>
            <p className="mb-3 text-sm font-medium leading-snug">{open.title}</p>
            <PopupRows rows={open.rows} />
            <Link
              href={`/${chainId}/proposals/${open.id}`}
              onClick={() => setOpenId(null)}
              className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
            >
              Full proposal, summary and votes →
            </Link>
          </>
        ) : null}
      </Popup>
    </div>
  );
}
