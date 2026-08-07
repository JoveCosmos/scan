"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { BlocksTable } from "@/components/blocks-table";
import type { BlockSummary } from "@/lib/blocks";

/**
 * Recent blocks, on demand.
 *
 * Blocks had a whole tab, but a scrolling list of heights is something you
 * glance at rather than navigate to — so it hangs off the latest-block figure
 * instead. The table only mounts once opened, so its polling costs nothing
 * until someone asks for it.
 *
 * Built on <dialog>, which brings focus trapping, Escape-to-close and inert
 * background content without a modal library.
 */
export function LiveBlocksDialog({
  chainId,
  initialBlocks,
  children,
}: {
  chainId: string;
  /** Rendered immediately on open; the poll takes over from there. */
  initialBlocks: BlockSummary[];
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // A native close — Escape, or the form-method close — must put React's state
  // back in sync. Without this the state stays true, the reopen click is a
  // no-op, and the dialog can never be opened a second time.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const sync = () => setOpen(false);
    dialog.addEventListener("close", sync);
    return () => dialog.removeEventListener("close", sync);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="block w-full cursor-pointer text-left"
        title="Show recent blocks"
      >
        {children}
      </button>

      <dialog
        ref={ref}
        // Clicking the backdrop closes; clicks inside the panel stop there.
        onClick={(e) => {
          if (e.target === ref.current) setOpen(false);
        }}
        className="w-[min(56rem,92vw)] rounded-xl border border-border bg-background p-0 text-foreground backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-medium">Recent blocks</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {/* Mounted only while open: unmounting stops the poll. Seeded from
              the server so the table is populated on open rather than empty
              until the first poll returns. */}
          {open ? (
            <BlocksTable chainId={chainId} initialBlocks={initialBlocks} />
          ) : null}
        </div>
      </dialog>
    </>
  );
}
