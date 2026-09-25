import Image from "next/image";

/**
 * The landing page's wallpaper: every network's mark, tiled and drifting.
 *
 * It replaced a row of labelled tiles under the search field. The page is now
 * the search field and nothing else, so what the explorer covers is said by the
 * room rather than by a menu — faint, and faded out behind the centre so the
 * one thing you can use never has a logo under it.
 *
 * The plane is a staggered grid where cell (row, col) shows mark
 * (row * STRIDE + col) mod n. It drifts one cell right and two rows down per
 * loop, then snaps back; the column shift is chosen so that the mark landing in
 * every cell after the move is the one that was there before, which is what
 * makes the snap invisible. Two rows, not one, because odd rows are offset by
 * half a cell and an odd shift would jump the stagger.
 */

export interface BackdropMark {
  key: string;
  accent: string;
  symbol: string;
  /** Null when we have no asset — drawn as a monogram instead. */
  logo: string | null;
}

const COLS = 20;
const ROWS = 14;
const STRIDE = 3;
const ROW_SHIFT = 2;

export function HomeBackdrop({ marks }: { marks: BackdropMark[] }) {
  const n = marks.length;
  if (n === 0) return null;
  const colShift = (((-ROW_SHIFT * STRIDE) % n) + n) % n;

  return (
    <div
      aria-hidden="true"
      className="gata-backdrop pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <div
        className="gata-backdrop-plane absolute"
        style={{
          ["--drift-x" as string]: `calc(${colShift} * var(--cell))`,
          ["--drift-y" as string]: `calc(${ROW_SHIFT} * var(--cell))`,
        }}
      >
        {Array.from({ length: ROWS }, (_, row) => (
          <div
            key={row}
            className="flex"
            style={{ marginLeft: row % 2 ? "calc(var(--cell) / 2)" : 0 }}
          >
            {Array.from({ length: COLS }, (_, col) => {
              const mark = marks[(row * STRIDE + col) % n];
              return (
                <span
                  key={col}
                  className="flex h-[var(--cell)] w-[var(--cell)] shrink-0 items-center justify-center"
                >
                  {mark.logo ? (
                    <Image
                      src={mark.logo}
                      alt=""
                      width={40}
                      height={40}
                      className="h-10 w-10 object-contain"
                    />
                  ) : (
                    <span
                      className="flex h-10 w-10 items-center justify-center rounded-full text-[11px] font-semibold"
                      style={{
                        background: `color-mix(in srgb, ${mark.accent} 22%, transparent)`,
                        color: mark.accent,
                      }}
                    >
                      {mark.symbol.slice(0, 3)}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
