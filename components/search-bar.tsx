"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

/**
 * Deliberately thin: it only routes to /[chain]/search, which resolves the term
 * against the chain. Keeping it a real <form> means it also works before
 * hydration and gets native mobile "Go" behaviour.
 */
export function SearchBar({
  chainId,
  // Kept short so it is not clipped in the narrow mobile field; the aria-label
  // and the empty search page carry the full explanation.
  placeholder = "Search…",
}: {
  chainId: string;
  placeholder?: string;
}) {
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
      action={`/${chainId}/search`}
      onSubmit={(e) => {
        const q = value.trim();
        if (!q) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        router.push(`/${chainId}/search?q=${encodeURIComponent(q)}`);
        setValue("");
        inputRef.current?.blur();
      }}
      className="relative min-w-0 flex-1"
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search block height, transaction hash or address"
        spellCheck={false}
        autoComplete="off"
        className="h-9 w-full rounded-lg border border-border bg-secondary/50 pl-9 pr-8 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[var(--gata-border-hi)] focus:bg-secondary"
      />
      {!value ? (
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
          /
        </kbd>
      ) : null}
    </form>
  );
}
