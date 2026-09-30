"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Deliberately thin: it only routes to /search, which resolves the term
 * against the chain. Keeping it a real <form> means it also works before
 * hydration and gets native mobile "Go" behaviour.
 */
export function SearchBar({
  chainId,
  // Names what the field actually accepts. "Search…" left the reader to guess,
  // and the three kinds are not obvious - an explorer search box could plausibly
  // want a validator name or a chain. Long enough to be clipped on a narrow
  // phone, which is fine: the visible part still says "address, tx…".
  placeholder = "address, tx or a block height…",
  size = "sm",
  showSlashHint = false,
}: {
  /** Optional hint: prefer this chain when a query matches several. */
  chainId?: string;
  placeholder?: string;
  /** "lg" is the landing page, where search is the whole page. */
  size?: "sm" | "lg";
  /**
   * Keep the "/" hint at every width. In the header it is a nicety that can be
   * dropped on a phone, which has no keyboard to press it on; on the landing
   * page it is the one place the shortcut is ever advertised, so it stays.
   */
  showSlashHint?: boolean;
}) {
  const large = size === "lg";
  const router = useRouter();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, unless the user is already typing somewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      role="search"
      action="/search"
      onSubmit={(e) => {
        const q = value.trim();
        if (!q) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        const hint = chainId ? `&chain=${encodeURIComponent(chainId)}` : "";
        router.push(`/search?q=${encodeURIComponent(q)}${hint}`);
        setValue("");
        inputRef.current?.blur();
      }}
      className="relative min-w-0 flex-1"
    >
      <Search
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
          large ? "left-4 h-4 w-4" : "left-3 h-3.5 w-3.5"
        )}
      />
      <input
        ref={inputRef}
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search block height, transaction hash or address"
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "w-full rounded-lg border border-border bg-secondary/50 outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[var(--gata-border-hi)] focus:bg-secondary",
          large
            ? "h-13 rounded-xl bg-[var(--gata-card)] pl-11 pr-10 text-base shadow-[0_18px_40px_-24px_rgba(var(--shade),var(--shadow-a))] focus:border-[var(--gata-blue)] focus:bg-[var(--gata-card)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--gata-blue)_22%,transparent)]"
            : "h-9 pl-9 pr-8 text-sm"
        )}
      />
      {!value ? (
        <kbd
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 rounded border border-border px-1.5 py-0.5 font-mono text-muted-foreground",
            showSlashHint ? "block" : "hidden sm:block",
            large ? "right-3.5 text-[11px]" : "right-2.5 text-[10px]"
          )}
        >
          /
        </kbd>
      ) : null}
    </form>
  );
}
