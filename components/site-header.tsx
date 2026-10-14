"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { SearchBar } from "@/components/search-bar";
import { ThemeToggle } from "@/components/theme-toggle";

export interface ChainSummary {
  chainId: string;
  prettyName: string;
  symbol: string;
  accent: string;
  /** Null when we have no asset - drawn as an accent dot instead. */
  logo: string | null;
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
  /** Account prefix, for routing addresses to their own chain. */
  bech32Prefix: string;
}

/** A network's logo, or its accent dot where we have no logo. */
function ChainMark({ chain, size = 18 }: { chain: ChainSummary; size?: number }) {
  if (chain.logo) {
    return (
      <Image
        src={chain.logo}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ background: chain.accent, boxShadow: `0 0 10px ${chain.accent}` }}
      />
    </span>
  );
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
        {active ? <ChainMark chain={active} /> : null}
        {/*
          The name drops below sm, leaving the accent dot and the chevron. This
          button does not shrink, so "Cosmos Hub Testnet" was 18 characters the
          search field paid for - and search is what the header is for. Nothing
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
                  // Every section now exists on every chain - one that has
                  // nothing to show says so rather than 404ing - so switching
                  // keeps the tab you were on instead of dropping you to the
                  // overview and making you find your way back.
                  href={`/${chain.chainId}${section || "/params"}`}
                  onClick={() => setOpen(false)}
                  role="option"
                  aria-selected={isActive}
                  className="flex items-center justify-between rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <span className="flex items-center gap-2.5">
                    <ChainMark chain={chain} size={22} />
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
  /** Used on a phone, where all seven must fit one row without scrolling. */
  short: string;
  governanceOnly?: boolean;
  ibcOnly?: boolean;
  section?: "txs" | "proposals" | "relayers";
}

// The chain's identity card, then its activity, then who runs it, then IBC,
// then what we run for it. The route is still /params.
const TABS: Tab[] = [
  { href: "/params", label: "Overview", short: "Home" },
  { href: "/validators", label: "Validators", short: "Vals" },
  {
    href: "/proposals",
    label: "Governance", short: "Gov",
    governanceOnly: true,
    section: "proposals",
  },
  {
    href: "/relayers",
    label: "Relayers", short: "IBC",
    ibcOnly: true,
    section: "relayers",
  },
  // Not chain-module gated: what we run for a chain, not what the chain has.
  { href: "/infra", label: "Infra", short: "Infra" },
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

  // Switching chains keeps you on the same section. Only the section survives -
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
      {/* A hairline of the current chain's accent along the header's edge. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px opacity-70"
        style={{
          background: `linear-gradient(90deg, transparent, ${chain?.accent ?? "var(--gata-blue)"} 30%, ${chain?.accent ?? "var(--gata-blue)"} 70%, transparent)`,
        }}
      />
      {/*
        Nothing in the header scrolls sideways, so it reflows by width:
        - phone: mark, search, switcher on top; all seven tabs, by their short
          names, share the full-width row under it
        - tablet: mark, tabs, switcher on top; search gets its own row
        - desktop: everything in one row
      */}
      <div className="mx-auto flex max-w-[90rem] flex-wrap items-center gap-x-3 px-4">
        <Link
          href="/"
          title="GATA SCAN"
          aria-label="GATA SCAN home"
          // Inset to the page's text column (titles and table text sit about
          // this far inside the card edges), so the G lines up with what is
          // read below it rather than with borders.
          className="group order-1 flex h-16 shrink-0 items-center pl-3.5"
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
            className="order-5 -mx-1 flex h-11 w-full items-center justify-between border-t border-border/60 sm:order-2 sm:mx-0 sm:h-16 sm:w-auto sm:flex-1 sm:justify-end sm:gap-1 sm:border-0"
          >
            {TABS.map((tab) => {
              // Blocks and transactions are browsed from the overview, so
              // their pages keep it lit.
              const active =
                routeChain !== null &&
                (pathname.startsWith(`/${chain.chainId}${tab.href}`) ||
                  (tab.href === "/params" &&
                    /^\/[^/]+\/(blocks|txs|photon)(\/|$)/.test(pathname)) ||
                  // Governors sit beside proposals under Governance.
                  (tab.href === "/proposals" && /^\/[^/]+\/governors(\/|$)/.test(pathname)));
              const na = unavailable(tab);
              return (
                <Link
                  key={tab.href}
                  href={`/${chain.chainId}${tab.href}`}
                  title={na ? `${tab.label}, N/A` : tab.label}
                  aria-current={active ? "page" : undefined}
                  className={`nav-tab px-2 sm:px-3 ${na && !active ? "opacity-45 hover:opacity-100" : ""}`}
                >
                  <span className="sm:hidden">{tab.short}</span>
                  <span className="hidden sm:inline">{tab.label}</span>
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
        ) : null}
        {/* On a phone the tabs leave the top row, so something must push the
            switcher right when there is no search to do it. */}
        {!chain ? <div className="order-2 flex-1 sm:hidden" /> : null}

        {/* Search is global; the active chain is only a tie-breaker hint. */}
        {/* The slot is always there so the header never reflows between the
            home page and the rest: on home it holds an empty box of the same
            size, since the page's own search field is the one to use. */}
        <div className="order-2 min-w-0 flex-1 sm:order-6 sm:w-full sm:flex-none sm:pb-2.5 lg:order-3 lg:w-72 lg:pb-0">
          {isHome ? (
            <div aria-hidden="true" className="h-9" />
          ) : (
            <SearchBar chainId={routeChain?.chainId} />
          )}
        </div>

        <div className="order-3 flex shrink-0 items-center gap-2 sm:order-4">
          <ChainSwitcher
            chains={chains}
            activeChainId={chain?.chainId ?? null}
            section={section}
          />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
