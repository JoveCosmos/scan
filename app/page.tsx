import { getAllChains, accentFor, symbolFor, logoFor } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";
import { HomeBackdrop, type BackdropMark } from "@/components/home-backdrop";

export const dynamic = "force-dynamic";

/**
 * The landing page is a search box, and nothing else.
 *
 * The networks it covers are the wallpaper behind it rather than a row of tiles
 * under it; the header's switcher is one click away for anyone who wants to
 * browse instead of search. The header's own search field is hidden here on
 * purpose — two search boxes on one screen is one too many.
 */
export default function HomePage() {
  // One mark per logo: a testnet shares its mainnet's, and repeating it would
  // weight the wallpaper toward whichever chain has the most networks.
  const marks = new Map<string, BackdropMark>();
  for (const chain of getAllChains()) {
    const logo = logoFor(chain);
    const key = logo ?? `mono:${chain.prettyName.split(" ")[0]}`;
    if (marks.has(key)) continue;
    marks.set(key, { key, logo, accent: accentFor(chain), symbol: symbolFor(chain) });
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-6rem)] max-w-2xl flex-col items-center justify-center px-4">
      <HomeBackdrop marks={[...marks.values()]} />

      <div className="w-full">
        {/* No chain hint on purpose: an ambiguous query — a bare block height,
            an address valid on several chains — should ask which chain rather
            than quietly picking one. */}
        <SearchBar size="lg" showSlashHint />
      </div>
    </main>
  );
}
