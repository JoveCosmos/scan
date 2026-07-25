"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Blocks, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChainSummary {
  chainId: string;
  prettyName: string;
  symbol: string;
}

const NAV = [
  { href: "", label: "Overview" },
  { href: "/blocks", label: "Blocks" },
  { href: "/validators", label: "Validators" },
];

function ChainSwitcher({
  chains,
  activeChainId,
}: {
  chains: ChainSummary[];
  activeChainId: string | null;
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
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
      >
        <span>{active ? active.prettyName : "Select chain"}</span>
        <ChevronDown
          className={cn("h-4 w-4 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {chains.map((chain) => {
            const isActive = chain.chainId === activeChainId;
            return (
              <li key={chain.chainId}>
                <Link
                  href={`/${chain.chainId}`}
                  onClick={() => setOpen(false)}
                  role="option"
                  aria-selected={isActive}
                  className="flex items-center justify-between rounded-sm px-2 py-2 text-sm hover:bg-accent"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{chain.prettyName}</span>
                    <span className="text-xs text-muted-foreground">{chain.chainId}</span>
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

export function SiteHeader({ chains }: { chains: ChainSummary[] }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const maybeChain = segments[0] ?? null;
  const activeChainId = chains.some((c) => c.chainId === maybeChain) ? maybeChain : null;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Blocks className="h-5 w-5 text-primary" />
          <span>Explorer</span>
        </Link>

        {activeChainId ? (
          <nav className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) => {
              const href = `/${activeChainId}${item.href}`;
              const isActive = pathname === href;
              return (
                <Link
                  key={item.label}
                  href={href}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        ) : (
          <span className="hidden text-sm text-muted-foreground sm:block">
            Multi-chain Cosmos block explorer
          </span>
        )}

        <ChainSwitcher chains={chains} activeChainId={activeChainId} />
      </div>

      {activeChainId ? (
        <nav className="flex items-center gap-1 overflow-x-auto border-t border-border px-4 py-2 sm:hidden">
          {NAV.map((item) => {
            const href = `/${activeChainId}${item.href}`;
            const isActive = pathname === href;
            return (
              <Link
                key={item.label}
                href={href}
                className={cn(
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-sm",
                  isActive
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </header>
  );
}
