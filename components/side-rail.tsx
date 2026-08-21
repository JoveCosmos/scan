"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  Boxes,
  Cable,
  Gauge,
  ChevronLeft,
  Server,
  ShieldCheck,
  Terminal,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChainSummary } from "@/components/site-header";

/**
 * Navigation as a vertical rail of square buttons.
 *
 * Replaces the two horizontal tab strips the header used to carry — one for
 * desktop, a second scrolling one for phones. A vertical rail needs neither: it
 * has room for every section at any width, so the same six buttons serve a
 * phone and a monitor, and nothing is ever hidden behind a sideways swipe.
 *
 * Sections sit at the top and the two other presentations at the bottom, with a
 * rule between them, because they answer different questions. The sections are
 * *parts* of a chain; the console is a way to read all of it.
 * There is no "pages" button among them — the section buttons are the pages, so
 * clicking one from the console is how you get back.
 *
 * Fixed to the viewport rather than scrolling with the document: the rail is
 * chrome, and chrome that scrolls away costs a trip back to the top.
 */

interface RailItem {
  href: string;
  label: string;
  icon: LucideIcon;
  governanceOnly?: boolean;
  ibcOnly?: boolean;
  section?: "txs" | "proposals" | "relayers";
}

// Same order the tab strip used: the chain's identity card, then its activity,
// then who runs it, then IBC. The route is still /params.
const SECTIONS: RailItem[] = [
  { href: "/params", label: "Overview", icon: Gauge },
  { href: "/blocks", label: "Blocks", icon: Boxes },
  { href: "/txs", label: "Txs", icon: ArrowLeftRight, section: "txs" },
  { href: "/validators", label: "Vals", icon: ShieldCheck },
  {
    href: "/proposals",
    label: "Gov",
    icon: Vote,
    governanceOnly: true,
    section: "proposals",
  },
  { href: "/relayers", label: "IBC", icon: Cable, ibcOnly: true, section: "relayers" },
  // Not chain-module gated: what we run for a chain, not what the chain has.
  { href: "/infra", label: "Infra", icon: Server },
];

// Not capability-gated: every chain can be read this way.
const MODES: RailItem[] = [
  { href: "/console", label: "Console", icon: Terminal },
];

function RailButton({
  item,
  chainId,
  active,
  unavailable,
}: {
  item: RailItem;
  chainId: string;
  active: boolean;
  /**
   * The section exists but this chain cannot serve it. Still a link: the page
   * says which of the two reasons it is, and a dead control that explains
   * nothing is worse than a live one that does.
   */
  unavailable?: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={`/${chainId}${item.href}`}
      title={unavailable ? `${item.label} — not available on this network` : item.label}
      aria-current={active ? "page" : undefined}
      aria-disabled={unavailable ? true : undefined}
      className={cn(
        "relative flex h-14 w-full flex-col items-center justify-center gap-1 transition-colors sm:h-16",
        active
          ? "bg-[var(--gata-card-hi)] text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        unavailable && !active && "opacity-40 hover:opacity-100"
      )}
    >
      {/* Marked rather than hidden. A tab that disappears on one chain and not
          another makes the reader wonder what else differs; a tab that says it
          has nothing to show answers the question before it is asked. */}
      {unavailable ? (
        <span className="absolute right-1 top-1 font-mono text-[7px] leading-none tracking-wide text-[var(--gata-faint)]">
          N/A
        </span>
      ) : null}
      {/* The lit edge, not an underline: on a vertical rail the active marker
          belongs on the side the content is. */}
      {active ? (
        <span className="absolute inset-y-0 left-0 w-[2px] bg-primary shadow-[0_0_8px_var(--gata-glow)]" />
      ) : null}
      <Icon className="h-[18px] w-[18px]" />
      <span className="text-[9px] font-medium uppercase leading-none tracking-[0.08em]">
        {item.label}
      </span>
    </Link>
  );
}

export function SideRail({
  chains,
  onCollapse,
}: {
  chains: ChainSummary[];
  onCollapse: () => void;
}) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const chain = chains.find((c) => c.chainId === segments[0]) ?? null;

  // Without a chain there is no section to show — the landing page is a search
  // box, and every route the rail points at is chain-scoped.
  if (!chain) return null;

  const segment = segments[1] ?? "";
  // Every section, for every chain. What differs is whether it has anything to
  // show — see `sectionUnavailable`, which the routes use for the same call.
  const unavailableFor = (item: RailItem) =>
    (item.governanceOnly && !chain.governance) ||
    (item.ibcOnly && !chain.ibc) ||
    (item.section !== undefined && !chain.sections[item.section]);

  return (
    <nav
      aria-label="Sections"
      className="fixed inset-y-0 left-0 z-50 flex w-14 flex-col border-r border-border bg-[color-mix(in_srgb,var(--gata-bg)_92%,transparent)] backdrop-blur-xl sm:w-16"
    >
      {/*
        A notch on the rail's outer edge, the way the hub does it. Half of the
        control sits outside the rail, which is what makes it read as a handle
        on the panel rather than another item in the menu — and puts it beside
        the top of the list rather than at the bottom, where it was competing
        with the section buttons for the same corner.
      */}
      <button
        type="button"
        onClick={onCollapse}
        title="Collapse menu"
        aria-label="Toggle menu"
        aria-expanded
        className="absolute right-[-13px] top-[34px] z-[2] grid h-[26px] w-[26px] place-items-center rounded-full border border-[var(--gata-border-hi)] bg-[var(--gata-card-hi)] text-muted-foreground shadow-[0_6px_16px_-8px_rgba(0,0,0,0.9)] transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-[13px] w-[13px]" />
      </button>

      {/*
        Deliberately unruled. A bottom border here would meet the rail's own
        right border and the header's, boxing the mark into the corner — three
        lines around a logo that needs none. The header's rule now starts where
        the rail ends, so the two read as one piece of chrome meeting at a
        corner rather than a frame around the brand.
      */}
      <Link
        href="/"
        title="GATA SCAN"
        className="group flex h-16 shrink-0 items-center justify-center"
      >
        <Image
          src="/gata_logo_white.png"
          alt="GATA SCAN"
          width={30}
          height={33}
          priority
          className="h-[26px] w-auto transition-[filter] group-hover:[filter:drop-shadow(0_0_10px_var(--gata-glow))]"
        />
      </Link>

      {/* Scrolls only if a chain ever carries more sections than fit. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {SECTIONS.map((item) => (
          <RailButton
            key={item.href}
            item={item}
            chainId={chain.chainId}
            unavailable={unavailableFor(item)}
            // startsWith so a detail page keeps its section lit.
            active={
              segment !== "console" &&
              pathname.startsWith(`/${chain.chainId}${item.href}`)
            }
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-border">
        {MODES.map((item) => (
          <RailButton
            key={item.href}
            item={item}
            chainId={chain.chainId}
            active={segment === item.href.slice(1)}
          />
        ))}
      </div>
    </nav>
  );
}
