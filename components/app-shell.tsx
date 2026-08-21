"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SideRail } from "@/components/side-rail";
import { SiteHeader, type ChainSummary } from "@/components/site-header";

/**
 * Holds the rail and the column beside it, and owns the menu's state.
 *
 * The flow follows the hub's, which is three states rather than two:
 *
 * - Wide, expanded. The rail is part of the layout at 224px and the column sits
 *   beside it. Nothing overlaps, so nothing needs a backdrop.
 * - Wide, collapsed. The rail narrows to 76px and keeps its icons; the column
 *   takes the width back. Remembered across visits, because it is a preference
 *   about how you like to work rather than about where you happen to be.
 * - Narrow. The rail becomes a drawer that slides over the page behind a
 *   backdrop and closes itself on navigation. Not remembered: a drawer left
 *   open across visits would cover the page on arrival.
 *
 * Collapsing and the drawer are deliberately separate. A phone has no use for
 * an icon-only rail permanently occupying a fifth of its width, so `collapsed`
 * is only ever read on a wide screen.
 *
 * The breakpoint is the hub's, not this app's usual one. It is about whether
 * 224px of chrome can be spared beside the content, which happens around 900px
 * regardless of what the rest of the layout does at 640.
 */

const COLLAPSE_KEY = "gata-scan-nav-collapsed";
const MOBILE_QUERY = "(max-width: 900px)";

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
  const pathname = usePathname();
  const hasChain = chains.some((c) => c.chainId === pathname.split("/")[1]);

  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [mobile, setMobile] = useState(false);

  // Resolved after mount rather than guessed during render: the server has no
  // viewport and no storage, so anything else is a hydration mismatch.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // Private browsing refuses storage; the rail simply starts expanded.
    }
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // The choice still holds for this visit.
      }
      return next;
    });
  }, []);

  // The tap that chose a page also dismisses the drawer.
  useEffect(() => {
    setDrawer(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawer) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawer(false);
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [drawer]);

  return (
    // The rail is a flex sibling rather than a fixed element the content is
    // padded around: collapsing then reflows the column by itself, with no
    // second measurement to keep in step with the first.
    <div className="flex h-dvh overflow-hidden">
      {hasChain && mobile && drawer ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setDrawer(false)}
          className="fixed inset-0 z-[44] bg-black/[0.62] backdrop-blur-[3px]"
        />
      ) : null}

      {hasChain ? (
        <SideRail
          chains={chains}
          collapsed={collapsed}
          onToggle={toggle}
          drawer={drawer}
          mobile={mobile}
        />
      ) : null}

      {/*
        The document does not scroll. The column is pinned to the viewport, so
        the rail and the header are always where you left them and no page can
        push them off the top. A page that fits its frame needs no scrolling at
        all; one that has not been fitted yet scrolls inside this element rather
        than moving the chrome.
      */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <SiteHeader
          chains={chains}
          onOpenMenu={hasChain && mobile ? () => setDrawer(true) : undefined}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer}
      </div>
    </div>
  );
}
