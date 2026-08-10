import Link from "next/link";
import { getAllChains, getChain, accentFor, type ChainConfig } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";
import { chainsByNodeType } from "@/lib/services";
import { EndpointsDialog, type DialogChain } from "@/components/endpoints-dialog";
import { ChainServicesPanel } from "@/components/chain-services-panel";

export const dynamic = "force-dynamic";

/**
 * The landing page is a search box.
 *
 * The chain switcher in the header already covers picking a network, so a grid
 * of chain cards duplicated it and put a click between arriving and searching.
 * Networks are still listed here — as links, so they remain a way in — but the
 * page's job is the one field in the middle.
 *
 * They are split by the kind of node we run, because the two are not the same
 * offer: a full node can serve history and a snapshot, a pruned one answers
 * current state and forgets. Grouping them says which is which without a
 * column of labels.
 */
export default function HomePage() {
  const chains = getAllChains();
  const { full, pruned } = chainsByNodeType();

  const resolve = (ids: { chainId: string }[]): ChainConfig[] =>
    ids
      .map((c) => getChain(c.chainId))
      .filter((c): c is ChainConfig => c !== undefined);

  const fullChains = resolve(full);
  const prunedChains = resolve(pruned);

  // Panels are built here, on the server, so the dialog has everything the
  // moment it opens.
  const dialogChains: DialogChain[] = [];
  for (const services of full) {
    const chain = getChain(services.chainId);
    if (!chain) continue;
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

      <div className="mt-6 flex flex-col items-center gap-3">
        {fullChains.length > 0 ? (
          <NetworkGroup label="Full nodes" chains={fullChains} />
        ) : null}
        {prunedChains.length > 0 ? (
          <NetworkGroup label="Pruned" chains={prunedChains} muted />
        ) : null}
      </div>

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

function NetworkGroup({
  label,
  chains,
  muted,
}: {
  label: string;
  chains: ChainConfig[];
  muted?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      {chains.map((chain) => (
        <NetworkChip key={chain.chainId} chain={chain} muted={muted} />
      ))}
    </div>
  );
}

function NetworkChip({ chain, muted }: { chain: ChainConfig; muted?: boolean }) {
  const accent = accentFor(chain);
  return (
    <Link
      href={`/${chain.chainId}/params`}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground"
      title={chain.chainId}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: accent,
          // The glow marks the nodes that carry history; pruned chains get the
          // same dot without it rather than a second kind of badge.
          boxShadow: muted ? undefined : `0 0 8px ${accent}`,
          opacity: muted ? 0.55 : 1,
        }}
      />
      {/* No "test" badge: every testnet already says so in its name. */}
      {chain.prettyName}
    </Link>
  );
}
