"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";

export interface PickerChain {
  chainId: string;
  prettyName: string;
  symbol: string;
  accent: string;
  network: "mainnet" | "testnet";
}

/**
 * Picking a network on the landing page.
 *
 * Distinct from the header's switcher, which *changes* chains and so keeps you
 * on the section you were reading. Here there is no section to keep — you have
 * not gone anywhere yet — so every choice lands on the chain's overview.
 *
 * Sized to sit under the search field as the second option rather than beside
 * it as an equal: search is what the page is for, and this is what you use when
 * you do not have a hash in hand.
 */
export function HomeChainPicker({ chains }: { chains: PickerChain[] }) {
  const router = useRouter();
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

  return (
    <div className="relative w-full" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 px-4 text-sm transition-colors hover:border-[var(--gata-border-hi)] hover:bg-secondary"
      >
        <span className="flex items-center gap-2.5 text-muted-foreground">
          <span className="flex -space-x-1">
            {/* The palette, as a preview of what is behind the button. */}
            {chains.slice(0, 4).map((c) => (
              <span
                key={c.chainId}
                className="h-2 w-2 rounded-full ring-2 ring-[var(--gata-bg)]"
                style={{ background: c.accent }}
              />
            ))}
          </span>
          Browse a network
        </span>
        <ChevronDown
          className={`h-4 w-4 opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label="Networks"
          className="absolute inset-x-0 z-50 mt-2 max-h-[min(60vh,22rem)] overflow-y-auto rounded-xl border border-border bg-popover/95 p-1 shadow-2xl backdrop-blur-xl"
        >
          {chains.map((chain) => (
            <li key={chain.chainId}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  setOpen(false);
                  // Always the overview: the landing page has no section to keep.
                  router.push(`/${chain.chainId}/params`);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: chain.accent,
                      boxShadow: `0 0 10px ${chain.accent}`,
                    }}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{chain.prettyName}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {chain.chainId}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {chain.symbol}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
