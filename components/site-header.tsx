"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Boxes,
  Cable,
  Check,
  ChevronDown,
  Gauge,
  Server,
  ShieldCheck,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { SearchBar } from "@/components/search-bar";
import { ThemeToggle } from "@/components/theme-toggle";

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
  /** The chain the tabs point at: the route's, or on the home page the last
   *  one visited. */
  activeChainId: string | null;
  /** Current section ("/blocks" | "/txs" | …), preserved across chains. */
  section: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = chains.find((c) => c.chainId === activeChainId);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
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
            style={{
              background: active.accent,
              boxShadow: `0 0 10px ${active.accent}`,
            }}
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
          className="absolute right-0 z-50 mt-2 max-h-[calc(100dvh-7rem)] w-60 overflow-y-auto rounded-xl border border-border bg-popover/95 p-1 shadow-2xl backdrop-blur-xl"
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
 * The header: the mark, search, the chain switcher, and the chain's sections.
 *
 * Sections are tabs in the header's one row rather than a side rail: the rail
 * cost 224px of width on every page to show seven words, and on a phone it hid
 * behind a drawer. The tabs scroll sideways on a narrow screen and are always
 * in view.
 *
 * The home page has no chain in its route, so there the tabs and the switcher
 * follow the last chain you visited (on a first visit, the first mainnet in
 * config order). Nothing is marked active, because you are not on any of them yet.
 */

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
  governanceOnly?: boolean;
  ibcOnly?: boolean;
  section?: "txs" | "proposals" | "relayers";
}

// The chain's identity card, then its activity, then who runs it, then IBC,
// then what we run for it. The route is still /params.
const TABS: Tab[] = [
  { href: "/params", label: "Overview", icon: Gauge },
  { href: "/blocks", label: "Blocks", icon: Boxes },
  { href: "/txs", label: "Transactions", icon: ArrowLeftRight, section: "txs" },
  { href: "/validators", label: "Validators", icon: ShieldCheck },
  {
    href: "/proposals",
    label: "Governance",
    icon: Vote,
    governanceOnly: true,
    section: "proposals",
  },
  {
    href: "/relayers",
    label: "Relayers",
    icon: Cable,
    ibcOnly: true,
    section: "relayers",
  },
  // Not chain-module gated: what we run for a chain, not what the chain has.
  { href: "/infra", label: "Infrastructure", icon: Server },
];

const LAST_CHAIN_KEY = "gata-scan-last-chain";

export function SiteHeader({ chains }: { chains: ChainSummary[] }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const routeChain = chains.find((c) => c.chainId === segments[0]) ?? null;

  // The landing page is built around its own search field. A second one in the
  // header directly above it says the same thing twice.
  const isHome = pathname === "/";

  // Resolved after mount: the server has no storage, so reading it during
  // render would be a hydration mismatch.
  const [lastChainId, setLastChainId] = useState<string | null>(null);
  useEffect(() => {
    try {
      if (routeChain) localStorage.setItem(LAST_CHAIN_KEY, routeChain.chainId);
      else setLastChainId(localStorage.getItem(LAST_CHAIN_KEY));
    } catch {
      // Private browsing refuses storage; home falls back to the first chain.
    }
  }, [routeChain]);

  const chain =
    routeChain ??
    chains.find((c) => c.chainId === lastChainId) ??
    chains.find((c) => c.network === "mainnet") ??
    chains[0] ??
    null;

  // Switching chains keeps you on the same section. Only the section survives —
  // a block height, tx hash or validator address means nothing on another
  // chain, so detail routes fall back to their list.
  const section =
    routeChain && TABS.some((t) => t.href === `/${segments[1]}`)
      ? `/${segments[1]}`
      : "";

  const unavailable = (tab: Tab) =>
    chain !== null &&
    ((tab.governanceOnly === true && !chain.governance) ||
      (tab.ibcOnly === true && !chain.ibc) ||
      (tab.section !== undefined && !chain.sections[tab.section]));

  return (
    <header className="relative z-30 shrink-0 border-b border-border bg-[color-mix(in_srgb,var(--gata-bg)_82%,transparent)] backdrop-blur-xl">
      {/*
        One row: the mark, the sections, search, the switcher. On a phone
        there is not the width for search beside seven tabs, so it wraps onto
        a row of its own underneath; the tabs keep the top row and scroll.
      */}
      <div className="mx-auto flex max-w-[90rem] flex-wrap items-center gap-x-3 px-4">
        <Link
          href="/"
          title="GATA SCAN"
          aria-label="GATA SCAN home"
          className="group flex h-14 shrink-0 items-center"
        >
          <Image
            src="/gata_logo_white.png"
            alt=""
            width={30}
            height={33}
            priority
            className="gata-mark h-[22px] w-auto transition-[filter] group-hover:[filter:var(--mark-filter)_drop-shadow(0_0_10px_var(--gata-glow))]"
          />
        </Link>

        {chain ? (
          <nav
            aria-label="Sections"
            style={{ ["--tab-acc" as string]: chain.accent }}
            className="flex h-14 min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
          >
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active =
                routeChain !== null &&
                pathname.startsWith(`/${chain.chainId}${tab.href}`);
              const na = unavailable(tab);
              return (
                <Link
                  key={tab.href}
                  href={`/${chain.chainId}${tab.href}`}
                  title={na ? `${tab.label} · N/A` : tab.label}
                  aria-current={active ? "page" : undefined}
                  className={`nav-tab ${na && !active ? "opacity-45 hover:opacity-100" : ""}`}
                >
                  <Icon className="hidden h-3.5 w-3.5 shrink-0 xl:block" />
                  {tab.label}
                  {/* Marked rather than hidden: a tab that vanishes on one
                      chain makes the reader wonder what else differs. */}
                  {na ? (
                    <span className="font-mono text-[8px] leading-none tracking-wide text-[var(--gata-faint)]">
                      N/A
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
        ) : (
          <div className="flex-1" />
        )}

        {/* Search is global; the active chain is only a tie-breaker hint. */}
        {isHome ? null : (
          <div className="order-last w-full pb-2.5 md:order-none md:w-64 md:pb-0 lg:w-72">
            <SearchBar chainId={routeChain?.chainId} />
          </div>
        )}

        <ChainSwitcher
          chains={chains}
          activeChainId={chain?.chainId ?? null}
          section={section}
        />
        <ThemeToggle />
      </div>
    </header>
  );
}
