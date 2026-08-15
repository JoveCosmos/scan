"use client";

import { useEffect, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";

export type Theme = "default" | "terminal";

export const THEME_KEY = "gata-scan-theme";

/**
 * Applied before first paint, from a script in the document head.
 *
 * Inlined as a string rather than imported, because it has to run before React
 * exists — reading the choice after hydration means every visitor on the
 * terminal theme watches the default one paint first.
 *
 * ?theme=terminal wins over the stored choice and then becomes it, so the view
 * is linkable: sending someone the terminal theme is a URL, not an instruction
 * to find a button.
 */
export const THEME_BOOTSTRAP = `try{var q=new URLSearchParams(location.search).get("theme");var t=q||localStorage.getItem(${JSON.stringify(
  THEME_KEY
)});if(q)localStorage.setItem(${JSON.stringify(
  THEME_KEY
)},q);if(t==="terminal")document.documentElement.dataset.theme="terminal"}catch(e){}`;

/**
 * Switches the room, not the furniture.
 *
 * Both themes are the same components and the same markup — only the tokens in
 * globals.css differ — so this sets one attribute and stores the choice. There
 * is no per-theme code anywhere else, which is the only reason keeping two of
 * them is honest rather than a maintenance debt.
 */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>("default");

  // The attribute is already correct when this mounts; read it rather than
  // localStorage so the button agrees with what is on screen.
  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "terminal" ? "terminal" : "default"
    );
  }, []);

  function toggle() {
    const next: Theme = theme === "terminal" ? "default" : "terminal";
    setTheme(next);
    if (next === "terminal") document.documentElement.dataset.theme = "terminal";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing refuses storage; the theme still applies for this visit.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={theme === "terminal"}
      title={theme === "terminal" ? "Standard theme" : "Terminal theme"}
      className={cn(
        "hidden shrink-0 rounded-lg border p-2 transition-colors sm:inline-flex",
        theme === "terminal"
          ? "border-[var(--gata-border-hi)] bg-secondary text-primary"
          : "border-border text-muted-foreground hover:border-[var(--gata-border-hi)] hover:text-foreground"
      )}
    >
      <SquareTerminal className="h-4 w-4" />
      <span className="sr-only">Toggle terminal theme</span>
    </button>
  );
}
