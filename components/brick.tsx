import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ink } from "@/lib/utils";

/**
 * A brick: one fact, or one group of facts, in a tile you can click.
 *
 * The unit the whole app is laid out in. A brick states the single number worth
 * knowing and hides the rest behind a click, which is what lets a page stay
 * inside one screen — a section that used to be eight rows down a scrolling page
 * is now one tile with those eight rows in its popup.
 *
 * Deliberately not a `.gata-panel`: a wall of frosted panels with glows costs a
 * lot to paint and reads as noise at this density. Flat surface, one hairline,
 * and the chain's accent used only where it means something.
 */

export function BrickGrid({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    // auto-fill rather than a fixed column count: the tiles are small enough
    // that a wide screen should get more of them, not wider ones.
    <div
      className={`grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2 ${className}`}
    >
      {children}
    </div>
  );
}

export interface BrickVisual {
  label: string;
  value: string;
  sub?: string;
  /** Tint the value with the chain accent — for the figure that identifies it. */
  lead?: boolean;
  tone?: "ok" | "bad";
  /** Shown bottom-right: how many fields the popup holds. */
  count?: number;
  /**
   * Render the value as prose over two lines rather than one mono figure. For
   * bricks whose identity is a title — a proposal — where a number would be the
   * least useful thing on the tile.
   */
  text?: boolean;
}

function toneColor(tone: BrickVisual["tone"], accent: string, lead?: boolean) {
  if (tone === "ok") return "var(--gata-green)";
  if (tone === "bad") return "var(--destructive)";
  if (lead) return ink(accent);
  return undefined;
}

function Body({
  brick,
  accent,
  opens,
}: {
  brick: BrickVisual;
  accent: string;
  /** Draws the corner mark. Only true where there is something behind the tile. */
  opens?: boolean;
}) {
  return (
    <>
      <span className="flex items-start justify-between gap-1">
        <span className="truncate text-[10px] font-medium uppercase leading-none tracking-[0.1em] text-muted-foreground">
          {brick.label}
        </span>
        {/*
          The affordance. A tile that opens and a tile that does not looked
          identical, so the only way to find out was to click one — and half of
          them are inert. Top corner rather than bottom: it sits beside the
          label, which is the part of a tile the eye lands on first, and leaves
          the figure's line uninterrupted.
        */}
        {opens ? (
          <span
            aria-hidden="true"
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-[var(--gata-border)] text-[var(--gata-faint)] transition-colors group-hover/brick:border-[var(--brick-acc)] group-hover/brick:text-foreground"
          >
            <ArrowUpRight className="h-2.5 w-2.5" />
          </span>
        ) : null}
      </span>
      <span
        className={
          brick.text
            ? "mt-auto line-clamp-2 text-[11.5px] font-medium leading-[1.2]"
            : "brick-value font-display mt-auto truncate text-[19px] font-semibold leading-tight tracking-[-0.02em] tabular-nums"
        }
        style={{ color: toneColor(brick.tone, accent, brick.lead) }}
      >
        {brick.value}
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className="truncate text-[10px] leading-tight text-muted-foreground">
          {brick.sub ?? ""}
        </span>
        {brick.count ? (
          <span className="shrink-0 font-mono text-[9px] text-[var(--gata-faint)]">
            {brick.count}
          </span>
        ) : null}
      </span>
    </>
  );
}

// Small enough that a board of them is read at a glance rather than scanned.
// The figure is still the largest thing in the tile; everything around it gave
// up the room instead.
const SHELL =
  "gata-surface gata-brick flex h-[5rem] flex-col gap-0.5 overflow-hidden px-3.5 py-2.5 text-left transition-[border-color,background-color,transform,box-shadow]";

/** Static — a fact with nothing behind it. */
export function Brick({ brick, accent }: { brick: BrickVisual; accent: string }) {
  return (
    <div className={SHELL} style={{ ["--brick-acc" as string]: accent }}>
      <Body brick={brick} accent={accent} />
    </div>
  );
}

/** Opens a popup. */
export function BrickButton({
  brick,
  accent,
  onClick,
}: {
  brick: BrickVisual;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${SHELL} gata-brick-open group/brick cursor-pointer`}
      style={{ ["--brick-acc" as string]: accent }}
    >
      <Body brick={brick} accent={accent} opens />
    </button>
  );
}

/** Goes somewhere — used where the detail is a whole page, not a popup. */
export function BrickLink({
  brick,
  accent,
  href,
}: {
  brick: BrickVisual;
  accent: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className={`${SHELL} gata-brick-open group/brick`}
      style={{ ["--brick-acc" as string]: accent }}
    >
      <Body brick={brick} accent={accent} opens />
    </Link>
  );
}
