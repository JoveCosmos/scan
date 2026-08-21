"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { SideRail } from "@/components/side-rail";
import { SiteHeader, type ChainSummary } from "@/components/site-header";

/**
 * Holds the rail, the column beside it, and whether the rail is open.
 *
 * The rail is chain-scoped and the landing page has no chain, so there the
 * column must not be indented past a rail that is not there. Which page we are
 * on is a client fact and the root layout is a server component, so the
 * decision lives here.
 *
 * Open and collapsed behave differently by width, which is the whole reason
 * this is one piece of state rather than a CSS class:
 *
 * - On a wide screen the rail is part of the layout. Open indents the column by
 *   exactly the rail's width; collapsed gives the width back. Because the rail
 *   is `fixed` it escapes that padding, so header, content and footer shift
 *   together and stay centred in the same space.
 * - On a phone the rail is a drawer. It overlays the column with a backdrop and
 *   never indents it — 56px is a sixth of a phone's width, and spending that on
 *   chrome that is idle most of the time is not a trade worth making. It also
 *   closes on navigation, because on a drawer the tap that chose a page is the
 *   same tap that should dismiss it.
 */

const RAIL_KEY = "gata-scan-rail";
const MOBILE = 640;

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

  const [open, setOpen] = useState(true);
  const [mobile, setMobile] = useState(false);

  // Resolved after mount rather than guessed during render: the server has no
  // viewport and no storage, so anything else is a hydration mismatch.
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE - 1}px)`);
    const sync = () => {
      setMobile(query.matches);
      // A phone starts closed whatever was stored — a drawer left open across
      // visits would cover the page on arrival.
      if (query.matches) setOpen(false);
      else {
        try {
          setOpen(localStorage.getItem(RAIL_KEY) !== "closed");
        } catch {
          setOpen(true);
        }
      }
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const setRail = useCallback(
    (next: boolean) => {
      setOpen(next);
      // Only a deliberate choice on a real layout is worth remembering; the
      // drawer's state is per-visit.
      if (mobile) return;
      try {
        localStorage.setItem(RAIL_KEY, next ? "open" : "closed");
      } catch {
        // Private browsing refuses storage; the choice still holds this visit.
      }
    },
    [mobile]
  );

  // The tap that chose a page also dismisses the drawer.
  useEffect(() => {
    if (mobile) setOpen(false);
  }, [pathname, mobile]);

  useEffect(() => {
    if (!mobile || !open) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [mobile, open]);

  const railVisible = hasChain && open;

  return (
    <>
      {railVisible ? <SideRail chains={chains} onCollapse={() => setRail(false)} /> : null}

      {/* Backdrop, phone only. */}
      {railVisible && mobile ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setRail(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
        />
      ) : null}

      {/*
        Reopens it. Same shape, same height, same edge — only the chevron turns
        round. A control that changed form between its two states would read as
        two different controls.
      */}
      {hasChain && !open ? (
        <button
          type="button"
          onClick={() => setRail(true)}
          title="Expand menu"
          aria-label="Toggle menu"
          aria-expanded={false}
          className="fixed left-1.5 top-[34px] z-50 grid h-[26px] w-[26px] place-items-center rounded-full border border-[var(--gata-border-hi)] bg-[var(--gata-card-hi)] text-muted-foreground shadow-[0_6px_16px_-8px_rgba(0,0,0,0.9)] transition-colors hover:text-foreground"
        >
          <ChevronRight className="h-[13px] w-[13px]" />
        </button>
      ) : null}

      {/*
        The document does not scroll. The column is pinned to the viewport, so
        the rail and the header are always where you left them and no page can
        push them off the top. A page that fits its frame needs no scrolling at
        all; one that has not been fitted yet scrolls inside this element rather
        than moving the chrome.
      */}
      <div
        className={`flex h-dvh flex-col overflow-hidden ${
          railVisible && !mobile ? "pl-14 sm:pl-16" : ""
        }`}
      >
        <SiteHeader chains={chains} />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer}
      </div>
    </>
  );
}
