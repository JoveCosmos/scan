import Link from "next/link";

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
      className={`grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5 ${className}`}
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
  if (lead) return accent;
  return undefined;
}

function Body({ brick, accent }: { brick: BrickVisual; accent: string }) {
  return (
    <>
      <span className="truncate text-[9px] font-medium uppercase leading-none tracking-[0.1em] text-muted-foreground">
        {brick.label}
      </span>
      <span
        className={
          brick.text
            ? "mt-auto line-clamp-2 text-[12px] font-medium leading-snug"
            : "mt-auto truncate font-mono text-[15px] font-semibold leading-tight"
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
          <span className="shrink-0 font-mono text-[10px] text-[var(--gata-faint)]">
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
  "flex h-[4.25rem] flex-col gap-0.5 overflow-hidden border border-border bg-[var(--gata-card)] px-2.5 py-2 text-left transition-colors";

/** Static — a fact with nothing behind it. */
export function Brick({ brick, accent }: { brick: BrickVisual; accent: string }) {
  return (
    <div className={SHELL}>
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
      className={`${SHELL} cursor-pointer hover:border-[var(--gata-border-hi)] hover:bg-[var(--gata-card-hi)]`}
    >
      <Body brick={brick} accent={accent} />
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
      className={`${SHELL} hover:border-[var(--gata-border-hi)] hover:bg-[var(--gata-card-hi)]`}
    >
      <Body brick={brick} accent={accent} />
    </Link>
  );
}
