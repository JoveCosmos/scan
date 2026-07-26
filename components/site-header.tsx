"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchBar } from "@/components/search-bar";

export interface ChainSummary {
  chainId: string;
  prettyName: string;
  symbol: string;
  accent: string;
  /** Chains without a gov module never show the Proposals tab. */
  governance: boolean;
}

const NAV = [
  { href: "", label: "Overview", short: "Overview" },
  { href: "/blocks", label: "Blocks", short: "Blocks" },
  // Shortened on narrow screens so all four tabs fit without a sideways swipe.
  { href: "/txs", label: "Transactions", short: "Txs" },
  { href: "/validators", label: "Validators", short: "Vals" },
  { href: "/proposals", label: "Proposals", short: "Props", governanceOnly: true },
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
        <span>{active ? active.prettyName : "Select chain"}</span>
        <ChevronDown
          className={cn("h-4 w-4 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-popover/95 p-1 shadow-2xl backdrop-blur-xl"
        >
          {chains.map((chain) => {
            const isActive = chain.chainId === activeChainId;
            return (
              <li key={chain.chainId}>
                <Link
                  href={`/${chain.chainId}${section}`}
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
  className,
  itemClassName,
}: {
  activeChainId: string;
  pathname: string;
  governance: boolean;
  className?: string;
  itemClassName?: string;
}) {
  return (
    <nav className={className}>
      {NAV.filter((item) => governance || !item.governanceOnly).map((item) => {
        const href = `/${activeChainId}${item.href}`;
        const isActive =
          item.href === "" ? pathname === href : pathname.startsWith(href);
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
              <span className="absolute inset-x-3 -bottom-[9px] h-px bg-primary shadow-[0_0_8px_var(--gata-glow)]" />
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
  const SECTIONS = ["blocks", "txs", "validators", "proposals"];
  const section =
    activeChainId && SECTIONS.includes(segments[1] ?? "") ? `/${segments[1]}` : "";

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-[color-mix(in_srgb,var(--gata-bg)_82%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg ring-1 ring-[var(--gata-border-hi)] transition-shadow group-hover:shadow-[0_0_18px_-4px_var(--gata-glow)]">
            <Image
              src="/gata_logo.jpg"
              alt=""
              width={36}
              height={36}
              priority
              className="h-full w-full object-cover"
            />
          </span>
          {/* Wordmark gives way to the mark alone on narrow screens so the
              search field has room in the top row. */}
          <span className="hidden flex-col gap-0.5 leading-none sm:flex">
            <span className="text-[15px] font-bold tracking-tight">GATA HUB</span>
            <span className="text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              Explorer
            </span>
          </span>
        </Link>

        {activeChainId ? (
          <NavLinks
            activeChainId={activeChainId}
            pathname={pathname}
            governance={activeChain?.governance ?? false}
            className="hidden items-center gap-1 lg:flex"
          />
        ) : (
          <span className="hidden text-sm text-muted-foreground lg:block">
            Multi-chain block explorer
          </span>
        )}

        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
          {activeChainId ? (
            <div className="min-w-0 max-w-xs flex-1">
              <SearchBar chainId={activeChainId} />
            </div>
          ) : null}
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
          className="flex items-center gap-1 overflow-x-auto border-t border-border px-4 py-2 lg:hidden"
        />
      ) : null}
    </header>
  );
}
