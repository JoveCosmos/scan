import { getAllChains, accentFor, symbolFor, logoFor } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";
import { HomeNetworks, type NetworkTile } from "@/components/home-networks";

export const dynamic = "force-dynamic";

/**
 * The landing page is a search box and the networks under it.
 *
 * The header's own search field is hidden here on purpose — two search boxes on
 * one screen is one too many, and the one you want is the one the page is built
 * around. Endpoints and snapshots used to hang off the bottom of this page;
 * they are a chain's infrastructure, so they live on that chain's Infra tab
 * now rather than under a dialog on a page about searching.
 */
export default function HomePage() {
  const chains: NetworkTile[] = getAllChains().map((chain) => ({
    chainId: chain.chainId,
    prettyName: chain.prettyName,
    symbol: symbolFor(chain),
    accent: accentFor(chain),
    logo: logoFor(chain),
  }));

  return (
    <main className="mx-auto flex h-[calc(100dvh-6rem)] max-w-2xl flex-col items-center justify-center px-4">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
        <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
        Live across {chains.length} networks
      </span>

      <div className="mt-7 w-full">
        {/* No chain hint on purpose: an ambiguous query — a bare block height,
            an address valid on several chains — should ask which chain rather
            than quietly picking one. */}
        <SearchBar size="lg" showSlashHint placeholder="" />
        <p className="mt-2.5 text-center text-xs text-muted-foreground">
          Search an address, a transaction hash, or a block height.
        </p>

        {/* The networks, laid out rather than folded into a dropdown: the count
            above is a claim, and this is the evidence for it. */}
        <div className="mt-7">
          <HomeNetworks chains={chains} />
        </div>
      </div>
    </main>
  );
}
