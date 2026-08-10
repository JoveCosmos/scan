"use client";

import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DialogChain {
  chainId: string;
  prettyName: string;
  accent: string;
  /** Rendered content for this chain, built on the server. */
  panel: React.ReactNode;
}

/**
 * Endpoints and snapshots, in a dialog rather than a page.
 *
 * A page meant a chain picker and a second navigation step to reach three short
 * lists. The dialog puts all of it one click from the landing page, with the
 * chains as tabs — the first is open by default, so nobody has to choose before
 * seeing anything.
 *
 * Every chain's panel is rendered on the server and passed in, so switching
 * tabs is instant and no data is fetched from the browser.
 */
export function EndpointsDialog({ chains }: { chains: DialogChain[] }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);

    // The page behind must not scroll while a dialog is over it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (chains.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="gata-panel gata-panel-interactive group mt-16 inline-flex items-center gap-2 px-5 py-2.5 text-sm transition-colors hover:border-[var(--gata-border-hi)]"
      >
        Endpoints and Snapshot
        <Maximize2 className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:scale-110" />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 pt-[8vh] backdrop-blur-sm"
          // No close button by design, so the backdrop is the way out and has
          // to be reliable. Only a click that both starts and ends on the
          // backdrop counts — otherwise a text selection that drifts outside
          // the panel would dismiss it mid-drag.
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Endpoints and snapshots"
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur-xl"
            style={{
              ["--panel-accent" as string]: chains[active]?.accent,
            }}
          >
            <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-2">
              {chains.map((chain, i) => (
                <button
                  key={chain.chainId}
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors",
                    i === active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: chain.accent,
                      boxShadow:
                        i === active ? `0 0 8px ${chain.accent}` : undefined,
                    }}
                  />
                  {chain.prettyName}
                </button>
              ))}
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-4">
              {chains[active]?.panel}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
