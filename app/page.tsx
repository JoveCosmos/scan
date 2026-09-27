import { getAllChains, accentFor, symbolFor, logoFor } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";
import { HomeOrbit, type OrbitMark } from "@/components/home-orbit";

export const dynamic = "force-dynamic";

/**
 * The landing page: the networks in orbit around the G, how many there are,
 * and the search field.
 *
 * The header's own search field is hidden here on purpose — two search boxes on
 * one screen is one too many, and the one you want is the one the page is built
 * around. The header keeps its tabs and switcher, so browsing is one click away.
 */
export default function HomePage() {
  const chains = getAllChains();

  // One mark per logo: a testnet shares its mainnet's, and repeating it would
  // weight the orbit toward whichever chain has the most networks. The first
  // chain to use a logo is the one it links to, which in config order is the
  // mainnet.
  const marks = new Map<string, OrbitMark>();
  for (const chain of chains) {
    const logo = logoFor(chain);
    const key = logo ?? `mono:${chain.prettyName.split(" ")[0]}`;
    if (marks.has(key)) continue;
    marks.set(key, {
      key,
      logo,
      href: `/${chain.chainId}/params`,
      name: chain.prettyName,
      accent: accentFor(chain),
      symbol: symbolFor(chain),
    });
  }

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4 py-6">
      <HomeOrbit marks={[...marks.values()]} />

      <span className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
        <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
        Live across {chains.length} networks
      </span>

      <div className="mt-6 w-full">
        {/* No chain hint on purpose: an ambiguous query — a bare block height,
            an address valid on several chains — should ask which chain rather
            than quietly picking one. */}
        <SearchBar size="lg" showSlashHint />
      </div>
    </main>
  );
}
