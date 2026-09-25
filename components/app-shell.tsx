"use client";

import { SiteHeader, type ChainSummary } from "@/components/site-header";

/**
 * The header, the page, and the footer, pinned to the viewport.
 *
 * Nothing at this level scrolls — not the document and not the column. Each
 * page is handed exactly the height between header and footer and has to fit
 * it (see `PageFrame`); where content is longer than that, the list itself
 * scrolls or pages, and the chrome never moves.
 */
export function AppShell({
  chains,
  footer,
  children,
}: {
  chains: ChainSummary[];
  /** Passed through from the server layout so it is not dragged client-side. */
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="gata-zoom flex flex-col overflow-hidden">
      <SiteHeader chains={chains} />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {footer}
    </div>
  );
}
