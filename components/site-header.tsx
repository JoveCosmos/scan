"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchBar } from "@/components/search-bar";
import { ThemeSwitch } from "@/components/theme-switch";
import { ViewSwitch } from "@/components/view-switch";

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

/** Every section, for headers rendered without an active chain. */
const ALL_SECTIONS = { txs: true, proposals: true, relayers: true };

// Overview first — it is the chain's identity card and the tab a chain lands on
// — then the chain's own activity (blocks, transactions), then who runs it
// (validators, governance), then IBC. The route is still /params; only the label
// changed, because "Params" described the implementation rather than the page.
// Labels shorten on narrow screens so every tab fits without a sideways swipe.
const NAV = [
  { href: "/params", label: "Overview", short: "Overview" },
  { href: "/blocks", label: "Blocks", short: "Blocks" },
  { href: "/txs", label: "Txs", short: "Txs", section: "txs" as const },
  { href: "/validators", label: "Validators", short: "Vals" },
  { href: "/proposals", label: "Proposals", short: "Props", governanceOnly: true, section: "proposals" as const },
  { href: "/relayers", label: "Relayers", short: "Relay", ibcOnly: true, section: "relayers" as const },
];

function ChainSwitcher({
  chains,
  activeChainId,
  section,
}: {
  chains: ChainSummary[];
  activeChainId: string | null;
  /** Current tab ("blocks" | "txs" | "validators"), preserved across chains. */
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
          is lost: the tab strip and the page heading below both name the chain,
          and the dot is its colour. Without an active chain the label stays at
          every width, since then there is nothing else to identify it.
        */}
        {active ? (
          <span className="hidden max-w-[9rem] truncate sm:inline">
            {active.prettyName}
          </span>
        ) : (
          <span>Select chain</span>
        )}
        <ChevronDown
          className={cn("h-4 w-4 opacity-60 transition-transform", open && "rotate-180")}
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
                  // Sections the target chain does not have would 404, so fall
                  // back to its overview.
                  href={`/${chain.chainId}${
                    (section === "/proposals" && !chain.governance) ||
                    (section === "/relayers" && !chain.ibc) ||
                    (section === "/txs" && !chain.sections.txs) ||
                    (section === "/proposals" && !chain.sections.proposals) ||
                    (section === "/relayers" && !chain.sections.relayers)
                      ? "/params"
                      : section || "/params"
                  }`}
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

function NavLinks({
  activeChainId,
  pathname,
  governance,
  ibc,
  sections,
  className,
  itemClassName,
  indicatorClassName = "-bottom-[9px]",
}: {
  activeChainId: string;
  pathname: string;
  governance: boolean;
  ibc: boolean;
  sections: ChainSummary["sections"];
  className?: string;
  itemClassName?: string;
  /**
   * Where the active-tab underline sits. The desktop row places it on the
   * header's bottom border, 9px below the link; the mobile row is its own strip
   * and must keep it inside, or it overflows the scroll container.
   */
  indicatorClassName?: string;
}) {
  return (
    <nav className={className}>
      {NAV.filter(
        (item) =>
          (governance || !item.governanceOnly) &&
          (ibc || !item.ibcOnly) &&
          (!item.section || sections[item.section])
      ).map((item) => {
        const href = `/${activeChainId}${item.href}`;
        // startsWith so a detail page keeps its section tab lit.
        const isActive = pathname.startsWith(href);
        return (
          <Link
            key={item.label}
            href={href}
            className={cn(
              // py-2 keeps the tab tap target ~36px on touch screens.
              "relative whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
              itemClassName
            )}
          >
            <span className="sm:hidden">{item.short}</span>
            <span className="hidden sm:inline">{item.label}</span>
            {isActive ? (
              <span
                className={cn(
                  "absolute inset-x-3 h-px bg-primary shadow-[0_0_8px_var(--gata-glow)]",
                  indicatorClassName
                )}
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function SiteHeader({ chains }: { chains: ChainSummary[] }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const maybeChain = segments[0] ?? null;
  const activeChain = chains.find((c) => c.chainId === maybeChain) ?? null;
  const activeChainId = activeChain?.chainId ?? null;


  // Switching chains keeps you on the same tab. Only the section survives — a
  // block height, tx hash or validator address means nothing on another chain,
  // so detail routes fall back to their list.
  // Console and canvas are here so switching chains keeps the presentation you
  // chose. Neither is capability-gated — every chain can be read either way.
  const SECTIONS = [
    "params",
    "blocks",
    "txs",
    "validators",
    "proposals",
    "console",
    "canvas",
  ];
  const section =
    activeChainId && SECTIONS.includes(segments[1] ?? "") ? `/${segments[1]}` : "";

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-[color-mix(in_srgb,var(--gata-bg)_82%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        {/*
          A lockup, not a mark with a word next to it. The G is geometric and
          heavy, so a bold sentence-case "Scan" at the same size fought it for
          attention and looked stuck on. Small caps with wide tracking read as
          type set alongside a logo — the mark stays dominant, the word explains
          it. Optically centred rather than baseline-aligned: with tracked caps
          there is no descender to align to, and the G's round overshoot makes
          an ink-bottom match look low.
        */}
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <Image
            src="/gata_logo_white.png"
            alt=""
            width={30}
            height={33}
            priority
            className="h-[30px] w-auto transition-[filter] group-hover:[filter:drop-shadow(0_0_10px_var(--gata-glow))]"
          />
          <span className="hidden text-[13px] font-medium uppercase leading-none tracking-[0.2em] text-foreground/90 transition-colors group-hover:text-foreground min-[360px]:inline">
            Scan
          </span>
        </Link>

        {activeChainId ? (
          <NavLinks
            activeChainId={activeChainId}
            pathname={pathname}
            governance={activeChain?.governance ?? false}
            ibc={activeChain?.ibc ?? false}
            sections={activeChain?.sections ?? ALL_SECTIONS}
            className="hidden items-center gap-1 lg:flex"
          />
        ) : null}

        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
          <div className="min-w-0 max-w-xs flex-1">
            {/* Search is global; the active chain is only a tie-breaker hint. */}
            <SearchBar chainId={activeChainId ?? undefined} />
          </div>
          {activeChainId ? <ViewSwitch chainId={activeChainId} /> : null}
          <ThemeSwitch />
          <ChainSwitcher
            chains={chains}
            activeChainId={activeChainId}
            section={section}
          />
        </div>
      </div>

      {activeChainId ? (
        <NavLinks
          activeChainId={activeChainId}
          pathname={pathname}
          governance={activeChain?.governance ?? false}
          ibc={activeChain?.ibc ?? false}
          sections={activeChain?.sections ?? ALL_SECTIONS}
          indicatorClassName="bottom-0"
          // overflow-y-hidden is not redundant: `overflow-x: auto` promotes a
          // `visible` overflow-y to `auto`, so without it the header grows a
          // vertical scrollbar on phones.
          className="flex items-center gap-1 overflow-x-auto overflow-y-hidden border-t border-border px-4 py-2 lg:hidden"
        />
      ) : null}
    </header>
  );
}
