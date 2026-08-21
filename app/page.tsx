import { getAllChains, accentFor, symbolFor } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";
import { HomeChainPicker, type PickerChain } from "@/components/home-chain-picker";

export const dynamic = "force-dynamic";

/**
 * The landing page is a search box and a way in.
 *
 * The header's own search field is hidden here on purpose — two search boxes on
 * one screen is one too many, and the one you want is the one the page is built
 * around. Endpoints and snapshots used to hang off the bottom of this page;
 * they are a chain's infrastructure, so they live on that chain's Infra tab
 * now rather than under a dialog on a page about searching.
 */
export default function HomePage() {
  const chains: PickerChain[] = getAllChains().map((chain) => ({
    chainId: chain.chainId,
    prettyName: chain.prettyName,
    symbol: symbolFor(chain),
    accent: accentFor(chain),
    network: chain.network,
  }));

  return (
    <main className="mx-auto flex h-[calc(100dvh-4rem)] max-w-3xl flex-col items-center justify-center px-4">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
        <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
        Live across {chains.length} networks
      </span>

      <div className="mt-7 w-full max-w-xl">
        {/* No chain hint on purpose: an ambiguous query — a bare block height,
            an address valid on several chains — should ask which chain rather
            than quietly picking one. */}
        <SearchBar size="lg" showSlashHint />
        <p className="mt-2.5 text-center text-xs text-muted-foreground">
          An address, a transaction hash, or a block height.
        </p>

        {/* Second option, not an equal one: a rule and a word between them so
            the field above stays the thing the page is for. */}
        <div className="mt-7 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            or
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="mt-4">
          <HomeChainPicker chains={chains} />
        </div>
      </div>
    </main>
  );
}
