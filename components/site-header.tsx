"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { SearchBar } from "@/components/search-bar";

export interface ChainSummary {
  chainId: string;
  prettyName: string;
  symbol: string;
  accent: string;
  /** Chains without a gov module never show the Proposals tab. */
  governance: boolean;
  /** Chains with no IBC module never show the Relayers tab. */
  ibc: boolean;
  /**
   * Sections this chain's tier offers. Distinct from the two flags above: those
   * say the module is absent, this says we chose not to carry the section.
   */
  sections: { txs: boolean; proposals: boolean; relayers: boolean };
  network: "mainnet" | "testnet";
}

function ChainSwitcher({
  chains,
  activeChainId,
  section,
}: {
  chains: ChainSummary[];
  activeChainId: string | null;
  /** Current section ("blocks" | "console" | …), preserved across chains. */
  section: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = chains.find((c) => c.chainId === activeChainId);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-1.5 text-sm font-medium transition-colors hover:border-[var(--gata-border-hi)] hover:bg-secondary"
      >
        {active ? (
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: active.accent, boxShadow: `0 0 10px ${active.accent}` }}
          />
        ) : null}
        {/*
          The name drops below sm, leaving the accent dot and the chevron. This
          button does not shrink, so "Cosmos Hub Testnet" was 18 characters the
          search field paid for — and search is what the header is for. Nothing
          is lost: the page heading below names the chain, and the dot is its
          colour. Without an active chain the label stays at every width, since
          then there is nothing else to identify it.
        */}
        {active ? (
          <span className="hidden max-w-[9rem] truncate sm:inline">
            {active.prettyName}
          </span>
        ) : (
          <span>Select chain</span>
        )}
        <ChevronDown
          className={`h-4 w-4 opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-popover/95 p-1 shadow-2xl backdrop-blur-xl"
        >
          {/*
            One flat list in config order, no mainnet/testnet headings: each
            testnet already says so in its name, and grouping separated AtomOne
            from its own testnet.
          */}
          {chains.map((chain) => {
            const isActive = chain.chainId === activeChainId;
            return (
              <li key={chain.chainId}>
                <Link
                  // Every section now exists on every chain — one that has
                  // nothing to show says so rather than 404ing — so switching
                  // keeps the tab you were on instead of dropping you to the
                  // overview and making you find your way back.
                  href={`/${chain.chainId}${section || "/params"}`}
                  onClick={() => setOpen(false)}
                  role="option"
                  aria-selected={isActive}
                  className="flex items-center justify-between rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        background: chain.accent,
                        boxShadow: `0 0 10px ${chain.accent}`,
                      }}
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">{chain.prettyName}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {chain.chainId}
                      </span>
                    </span>
                  </span>
                  {isActive ? <Check className="h-4 w-4 text-primary" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The header, once the navigation left it.
 *
 * Sections used to live here as two tab strips — one for desktop and a second
 * scrolling one for phones — and the logo anchored the left. All three moved to
 * `SideRail`, which has room for every section at any width. What is left is
 * what the header was always actually for: search, and which chain you are
 * searching. Search takes the space the tabs used to.
 */
export function SiteHeader({ chains }: { chains: ChainSummary[] }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const maybeChain = segments[0] ?? null;
  const activeChainId =
    chains.find((c) => c.chainId === maybeChain)?.chainId ?? null;

  // Switching chains keeps you on the same section. Only the section survives —
  // a block height, tx hash or validator address means nothing on another chain,
  // so detail routes fall back to their list.
  // Every section, so switching chains always keeps the tab you were on.
  // `relayers` was missing here and silently dropped you to the overview.
  const SECTIONS = [
    "params",
    "blocks",
    "txs",
    "validators",
    "proposals",
    "relayers",
    "infra",
    "console",
  ];
  const section =
    activeChainId && SECTIONS.includes(segments[1] ?? "") ? `/${segments[1]}` : "";

  // The landing page is built around its own search field. A second one in the
  // header directly above it says the same thing twice, and leaves the reader
  // to work out whether the two differ.
  const isHome = pathname === "/";

  return (
    // shrink-0, not sticky: the column no longer scrolls, so there is nothing
    // to stick to and a sticky element here only creates a stacking context.
    <header className="shrink-0 border-b border-border bg-[color-mix(in_srgb,var(--gata-bg)_82%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-end gap-3 px-4">
        {/*
          The mark lives in the rail, and the rail only exists once a chain is
          chosen. Without one it belongs here instead — same corner of the
          screen, so it does not appear to move between the two.
        */}
        {activeChainId ? null : (
          <Link href="/" className="group mr-auto flex shrink-0 items-center gap-2.5">
            <Image
              src="/gata_logo_white.png"
              alt=""
              width={30}
              height={33}
              priority
              className="h-[26px] w-auto transition-[filter] group-hover:[filter:drop-shadow(0_0_10px_var(--gata-glow))]"
            />
            <span className="hidden text-[13px] font-medium uppercase leading-none tracking-[0.2em] text-foreground/90 min-[380px]:inline">
              Scan
            </span>
          </Link>
        )}

        {/* Search is global; the active chain is only a tie-breaker hint. */}
        {isHome ? null : (
          <div className="min-w-0 max-w-xl flex-1">
            <SearchBar chainId={activeChainId ?? undefined} />
          </div>
        )}

        {/* The landing page has its own picker, in the row it belongs to. A
            second one up here is the same control twice on one screen. */}
        {isHome ? null : (
          <ChainSwitcher
            chains={chains}
            activeChainId={activeChainId}
            section={section}
          />
        )}
      </div>
    </header>
  );
}
