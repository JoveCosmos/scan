"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { List, Terminal, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Which presentation of the chain you are reading.
 *
 * Deliberately not part of the section nav. Overview, Blocks and Validators are
 * *parts* of a chain; pages, console and canvas are three ways to read all of
 * it, which makes this a sibling of the theme switch rather than of the tabs.
 * Putting it in the tab strip would have implied a fourth section and left the
 * strip claiming two different kinds of thing.
 *
 * Only rendered with an active chain, since every mode is chain-scoped.
 */
const MODES = [
  { key: "pages", href: "/params", icon: List, label: "Pages" },
  { key: "console", href: "/console", icon: Terminal, label: "Console" },
  { key: "canvas", href: "/canvas", icon: Waypoints, label: "Canvas" },
];

export function ViewSwitch({ chainId }: { chainId: string }) {
  const pathname = usePathname();
  const segment = pathname.split("/").filter(Boolean)[1] ?? "";
  // Anything that is not the console or the canvas is an ordinary page, so the
  // default lights up on every detail route without listing them.
  const active =
    segment === "console" ? "console" : segment === "canvas" ? "canvas" : "pages";

  return (
    <div
      className="hidden shrink-0 items-center rounded-lg border border-border bg-secondary/60 p-0.5 sm:flex"
      role="group"
      aria-label="Presentation"
    >
      {MODES.map((mode) => {
        const Icon = mode.icon;
        const isActive = active === mode.key;
        return (
          <Link
            key={mode.key}
            href={`/${chainId}${mode.href}`}
            aria-label={mode.label}
            title={mode.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-md px-2 py-1.5 transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
          </Link>
        );
      })}
    </div>
  );
}
