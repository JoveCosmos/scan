import Image from "next/image";
import Link from "next/link";

/**
 * The networks, as a row of marks under the search field.
 *
 * This replaced a dropdown. A dropdown hides its contents until you commit to
 * opening it, which is the wrong trade on a landing page whose whole job is to
 * say what is here — nine networks behind a chevron read as one option, and the
 * same nine laid out read as coverage.
 *
 * Each tile carries a name as well as a mark. Half these logos are recognisable
 * on sight and half are not, and a row of unlabelled glyphs is a guessing game.
 * The name also gives the tap target a sensible size on a phone, where a 32px
 * logo on its own would be under the threshold.
 *
 * Every tile lands on the chain's overview. Unlike the header's switcher there
 * is no section to preserve, because you have not gone anywhere yet.
 */

export interface NetworkTile {
  chainId: string;
  prettyName: string;
  symbol: string;
  accent: string;
  /** Null when we have no asset — the tile falls back to a monogram. */
  logo: string | null;
}

export function HomeNetworks({ chains }: { chains: NetworkTile[] }) {
  return (
    <nav aria-label="Networks" className="flex flex-wrap justify-center gap-1.5">
      {chains.map((chain) => (
        <Link
          key={chain.chainId}
          href={`/${chain.chainId}/params`}
          title={`${chain.prettyName} · ${chain.chainId}`}
          className="group flex w-[4.75rem] flex-col items-center gap-1.5 rounded-lg border border-border bg-[var(--gata-card)] px-1.5 py-2 transition-colors hover:border-[var(--gata-border-hi)] hover:bg-[var(--gata-card-hi)]"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full transition-[filter] group-hover:[filter:drop-shadow(0_0_8px_var(--tile-accent))]"
            style={{ ["--tile-accent" as string]: chain.accent }}
          >
            {chain.logo ? (
              <Image
                src={chain.logo}
                alt=""
                width={28}
                height={28}
                className="h-7 w-7 object-contain"
              />
            ) : (
              /* No asset for this chain. A monogram on its own accent reads as
                 deliberate, where a broken image reads as a bug. */
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{
                  background: `color-mix(in srgb, ${chain.accent} 18%, transparent)`,
                  color: chain.accent,
                }}
              >
                {chain.symbol.slice(0, 3)}
              </span>
            )}
          </span>

          <span className="w-full truncate text-center text-[10px] leading-none text-muted-foreground transition-colors group-hover:text-foreground">
            {chain.prettyName}
          </span>
        </Link>
      ))}
    </nav>
  );
}
