import Image from "next/image";
import Link from "next/link";

/**
 * The networks, as one slow-moving row of marks under the search field.
 *
 * Names are left to the tooltip: the row says "all of these", and the header's
 * switcher is where you go to pick one by name.
 *
 * The track is the list twice over and slides left by half its width per loop,
 * so the second copy lands exactly where the first began. Each copy has to be
 * wider than the field it runs under or the wrap shows as a gap, hence the
 * padding out to MIN_PER_COPY marks.
 */

export interface MarqueeMark {
  key: string;
  href: string;
  name: string;
  accent: string;
  symbol: string;
  /** Null when we have no asset — drawn as a monogram instead. */
  logo: string | null;
}

const MIN_PER_COPY = 12;

export function HomeMarquee({ marks }: { marks: MarqueeMark[] }) {
  if (marks.length === 0) return null;
  const repeat = Math.ceil(MIN_PER_COPY / marks.length);
  const copy = Array.from({ length: repeat }, () => marks).flat();

  return (
    <nav aria-label="Networks" className="gata-marquee w-full overflow-hidden py-2">
      <div className="gata-marquee-track flex w-max">
        {[0, 1].map((half) =>
          copy.map((mark, i) => (
            <Link
              key={`${half}-${i}`}
              href={mark.href}
              title={mark.name}
              // Only the first copy of each mark is announced and tabbable; the
              // rest are the same link again, there only to fill the loop.
              aria-hidden={half > 0 || i >= marks.length ? true : undefined}
              tabIndex={half > 0 || i >= marks.length ? -1 : undefined}
              className="group mx-4 flex h-9 w-9 shrink-0 items-center justify-center rounded-full opacity-60 grayscale-[0.4] transition-[opacity,filter] hover:opacity-100 hover:grayscale-0"
              style={{ ["--mark-accent" as string]: mark.accent }}
            >
              {mark.logo ? (
                <Image
                  src={mark.logo}
                  alt={mark.name}
                  width={36}
                  height={36}
                  className="h-9 w-9 object-contain group-hover:[filter:drop-shadow(0_0_10px_var(--mark-accent))]"
                />
              ) : (
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[10px] font-semibold"
                  style={{
                    background: `color-mix(in srgb, ${mark.accent} 20%, transparent)`,
                    color: mark.accent,
                  }}
                >
                  {mark.symbol.slice(0, 3)}
                </span>
              )}
            </Link>
          ))
        )}
      </div>
    </nav>
  );
}
