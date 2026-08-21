"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  Boxes,
  Cable,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Server,
  ShieldCheck,
  Terminal,
  Vote,
  type LucideIcon,
} from "lucide-react";
import type { ChainSummary } from "@/components/site-header";

/**
 * Navigation, following the hub's menu so the two products behave the same way.
 *
 * The shape of that behaviour is three states rather than two. On a wide screen
 * the rail is part of the layout and collapsing narrows it from 224px to 76px —
 * it keeps the icons and drops the labels, so the menu never actually leaves.
 * On a narrow one it is a drawer that slides over the page and closes itself
 * when you navigate. Collapsing and the drawer are separate ideas: a phone has
 * no use for an icon-only rail permanently occupying a fifth of its width, so
 * the collapsed state is deliberately a desktop-only thing.
 *
 * Sections at the top, the console below a rule, because the sections are parts
 * of a chain and the console is a way to read all of it. Every section shows
 * for every chain; one this chain cannot serve is marked rather than hidden.
 */

const EXPANDED = 224;
const COLLAPSED = 76;

interface RailItem {
  href: string;
  label: string;
  icon: LucideIcon;
  governanceOnly?: boolean;
  ibcOnly?: boolean;
  section?: "txs" | "proposals" | "relayers";
}

// The chain's identity card, then its activity, then who runs it, then IBC,
// then what we run for it. The route is still /params.
const SECTIONS: RailItem[] = [
  { href: "/params", label: "Overview", icon: Gauge },
  { href: "/blocks", label: "Blocks", icon: Boxes },
  { href: "/txs", label: "Transactions", icon: ArrowLeftRight, section: "txs" },
  { href: "/validators", label: "Validators", icon: ShieldCheck },
  {
    href: "/proposals",
    label: "Governance",
    icon: Vote,
    governanceOnly: true,
    section: "proposals",
  },
  { href: "/relayers", label: "Relayers", icon: Cable, ibcOnly: true, section: "relayers" },
  // Not chain-module gated: what we run for a chain, not what the chain has.
  { href: "/infra", label: "Infrastructure", icon: Server },
];

const MODES: RailItem[] = [{ href: "/console", label: "Console", icon: Terminal }];

function RailLink({
  item,
  chainId,
  active,
  unavailable,
  iconOnly,
}: {
  item: RailItem;
  chainId: string;
  active: boolean;
  /**
   * The section exists but this chain cannot serve it. Still a link: the page
   * says which of the two reasons it is, and a dead control that explains
   * nothing is worse than a live one that does.
   */
  unavailable: boolean;
  iconOnly: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={`/${chainId}${item.href}`}
      title={unavailable ? `${item.label} — not available on this network` : item.label}
      aria-current={active ? "page" : undefined}
      aria-disabled={unavailable ? true : undefined}
      className={`rail-item ${iconOnly ? "justify-center" : ""} ${
        unavailable && !active ? "opacity-40 hover:opacity-100" : ""
      }`}
    >
      <span className="rail-ico">
        <Icon className="h-[15px] w-[15px]" />
      </span>

      {iconOnly ? null : (
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      )}

      {/* Marked rather than hidden. A tab that disappears on one chain and not
          another makes the reader wonder what else differs; a tab that says it
          has nothing to show answers the question before it is asked. */}
      {unavailable ? (
        <span
          className={`font-mono text-[8px] leading-none tracking-wide text-[var(--gata-faint)] ${
            iconOnly ? "absolute right-1 top-1" : "shrink-0"
          }`}
        >
          N/A
        </span>
      ) : null}
    </Link>
  );
}

export function SideRail({
  chains,
  collapsed,
  onToggle,
  drawer,
  mobile,
}: {
  chains: ChainSummary[];
  /** Desktop only — see the module comment. */
  collapsed: boolean;
  onToggle: () => void;
  /** Whether the drawer is showing, on a narrow screen. */
  drawer: boolean;
  mobile: boolean;
}) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const chain = chains.find((c) => c.chainId === segments[0]) ?? null;

  // Without a chain there is no section to show — the landing page is a search
  // box, and every route the rail points at is chain-scoped.
  if (!chain) return null;

  const segment = segments[1] ?? "";
  const iconOnly = !mobile && collapsed;

  const unavailableFor = (item: RailItem) =>
    (item.governanceOnly === true && !chain.governance) ||
    (item.ibcOnly === true && !chain.ibc) ||
    (item.section !== undefined && !chain.sections[item.section]);

  const isActive = (item: RailItem) =>
    item.href === "/console"
      ? segment === "console"
      : segment !== "console" && pathname.startsWith(`/${chain.chainId}${item.href}`);

  return (
    <aside
      style={{
        width: iconOnly ? COLLAPSED : EXPANDED,
        padding: iconOnly ? "18px 10px" : "22px 16px",
        ...(mobile
          ? {
              position: "fixed" as const,
              top: 0,
              left: 0,
              height: "100dvh",
              zIndex: 45,
              transform: drawer ? "translateX(0)" : "translateX(-100%)",
              transition: "transform .22s ease",
              boxShadow: drawer ? "0 0 60px -10px rgba(0,0,0,0.8)" : "none",
            }
          : { transition: "width .18s ease" }),
        ["--rail-acc" as string]: chain.accent,
      }}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-[var(--gata-bg2)]"
    >
      <Link
        href="/"
        title="GATA SCAN"
        className={`group mb-5 flex shrink-0 items-center gap-2.5 ${
          iconOnly ? "justify-center" : ""
        }`}
      >
        <Image
          src="/gata_logo_white.png"
          alt=""
          width={30}
          height={33}
          priority
          className="h-[26px] w-auto transition-[filter] group-hover:[filter:drop-shadow(0_0_10px_var(--gata-glow))]"
        />
        {iconOnly ? null : (
          <span className="text-[13px] font-medium uppercase leading-none tracking-[0.2em] text-foreground/90">
            Scan
          </span>
        )}
      </Link>

      {/*
        A notch on the rail's outer edge. Half of the control sits outside the
        panel, which is what makes it read as a handle on it rather than one
        more item in the menu. Hidden on a phone, where the rail is a drawer
        with a backdrop and collapsing means nothing.
      */}
      {mobile ? null : (
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          aria-label="Toggle menu"
          aria-expanded={!collapsed}
          className="rail-toggle absolute right-[-13px] top-[34px] z-[2] grid h-[26px] w-[26px] place-items-center rounded-full border border-[var(--gata-border-hi)] bg-[var(--gata-card-hi)] text-muted-foreground shadow-[0_6px_16px_-8px_rgba(0,0,0,0.9)]"
        >
          {collapsed ? (
            <ChevronRight className="h-[13px] w-[13px]" />
          ) : (
            <ChevronLeft className="h-[13px] w-[13px]" />
          )}
        </button>
      )}

      <nav
        aria-label="Sections"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
      >
        {SECTIONS.map((item) => (
          <RailLink
            key={item.href}
            item={item}
            chainId={chain.chainId}
            active={isActive(item)}
            unavailable={unavailableFor(item)}
            iconOnly={iconOnly}
          />
        ))}
      </nav>

      <div className="mt-2 shrink-0 border-t border-border pt-2">
        {MODES.map((item) => (
          <RailLink
            key={item.href}
            item={item}
            chainId={chain.chainId}
            active={isActive(item)}
            unavailable={false}
            iconOnly={iconOnly}
          />
        ))}
      </div>
    </aside>
  );
}
