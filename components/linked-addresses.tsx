"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { truncateMiddle } from "@/lib/format";
import type { LinkedAddress } from "@/lib/bech32";

/**
 * The same key produces a different address on every chain — only the prefix
 * differs. This offers those counterparts so you can follow one account across
 * chains without re-deriving the address by hand.
 */
export function LinkedAddresses({
  links,
  currentChainId,
}: {
  links: LinkedAddress[];
  currentChainId: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  if (links.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Same account on other chains"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5 py-1.5 text-xs transition-colors hover:border-[var(--gata-border-hi)]"
      >
        <Link2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Other chains</span>
        <span className="text-muted-foreground">{links.length}</span>
      </button>

      {open ? (
        <ul
          role="listbox"
          className="absolute left-0 z-50 mt-2 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover/95 p-1 shadow-2xl backdrop-blur-xl"
        >
          <li className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Same account elsewhere
          </li>
          {links.map((link) => {
            const isCurrent = link.chainId === currentChainId;
            return (
              <li key={link.chainId}>
                <Link
                  href={`/${link.chainId}/accounts/${link.address}`}
                  onClick={() => setOpen(false)}
                  role="option"
                  aria-selected={isCurrent}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent",
                    isCurrent && "bg-accent/50"
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{link.label}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {truncateMiddle(link.address, 14, 8)}
                    </span>
                  </span>
                  {isCurrent ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
