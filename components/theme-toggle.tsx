"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * Day and night.
 *
 * With nothing saved the system preference decides, and there is no attribute
 * on <html>. A click saves an explicit choice and stamps it; the script in
 * app/layout.tsx re-applies it before paint on the next visit, so the page
 * never flashes the other theme first.
 */

export const THEME_KEY = "gata-scan-theme";

type Theme = "light" | "dark";

function current(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeToggle() {
  // Unknown until mounted: the server cannot see the reader's theme.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(current());
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setTheme(current());
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  function toggle() {
    const next: Theme = current() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage refused: the choice holds for this page view.
    }
    setTheme(next);
  }

  const label = theme === "light" ? "Switch to night mode" : "Switch to day mode";

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-secondary/60 text-muted-foreground transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground"
    >
      {theme === null ? null : theme === "light" ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Sun className="h-4 w-4" />
      )}
    </button>
  );
}
