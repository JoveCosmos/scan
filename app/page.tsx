import { getAllChains, getChain, accentFor } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";
import { getServices } from "@/lib/services";
import { policyFor } from "@/lib/tiers";
import { EndpointsDialog, type DialogChain } from "@/components/endpoints-dialog";
import { ChainServicesPanel } from "@/components/chain-services-panel";

export const dynamic = "force-dynamic";

/**
 * The landing page is a search box.
 *
 * The chain switcher in the header already covers picking a network, so listing
 * the chains here said the same thing twice and put a click between arriving and
 * searching. The count stays — it is the one fact about coverage worth stating —
 * and picking a network is the header's job.
 */
export default function HomePage() {
  const chains = getAllChains();

  // Panels are built here, on the server, so the dialog has everything the
  // moment it opens. Only chains we run a full node for have endpoints and a
  // snapshot to offer.
  const dialogChains: DialogChain[] = [];
  for (const services of getServices().chains) {
    const chain = getChain(services.chainId);
    if (!chain || !policyFor(chain).fullNode) continue;
    dialogChains.push({
      chainId: chain.chainId,
      prettyName: chain.prettyName,
      accent: accentFor(chain),
      panel: <ChainServicesPanel chain={chain} services={services} />,
    });
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-3xl flex-col items-center justify-center px-4 py-16">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
        <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
        Live across {chains.length} networks
      </span>

      <div className="mt-8 w-full max-w-xl">
        {/* No chain hint on purpose: an ambiguous query — a bare block height,
            an address valid on several chains — should ask which chain rather
            than quietly picking one. */}
        <SearchBar size="lg" />
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Search an address, a transaction hash, or a block height.
        </p>
      </div>

      {/* Set well below the search field: a second destination, not an
          alternative to the thing the page is for. */}
      <EndpointsDialog chains={dialogChains} />
    </main>
  );
}
