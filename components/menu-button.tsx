"use client";

import { Menu } from "lucide-react";

/**
 * The drawer's handle, shown in the header only where the rail is hidden.
 *
 * Its own file rather than living beside the shell that uses it: the header
 * needs it and the shell renders the header, so keeping it in either one puts
 * a cycle between the two.
 */
export function MenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Menu"
      aria-label="Toggle menu"
      className="shrink-0 rounded-lg border border-border bg-secondary/60 p-2 text-muted-foreground transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground"
    >
      <Menu className="h-4 w-4" />
    </button>
  );
}
