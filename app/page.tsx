import Link from "next/link";
import { getAllChains, accentFor, DEFAULT_CHAIN_ID } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";

export const dynamic = "force-dynamic";

/**
 * The landing page is a search box.
 *
 * The chain switcher in the header already covers picking a network, so a grid
 * of chain cards duplicated it and put a click between arriving and searching.
 * Networks are still listed here — as links, so they remain a way in — but the
 * page's job is the one field in the middle.
 */
export default function HomePage() {
  const chains = getAllChains();
  const mainnet = chains.filter((c) => c.network === "mainnet");
  const testnet = chains.filter((c) => c.network !== "mainnet");

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-3xl flex-col items-center justify-center px-4 py-16">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
        <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
        Live across {chains.length} networks
      </span>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
        {mainnet.map((chain) => (
          <NetworkChip key={chain.chainId} chain={chain} />
        ))}
        {testnet.length > 0 ? (
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        ) : null}
        {testnet.map((chain) => (
          <NetworkChip key={chain.chainId} chain={chain} testnet />
        ))}
      </div>

      <div className="mt-8 w-full max-w-xl">
        {/* Searching without a chain in the URL resolves against the default
            network; an address carrying another chain's prefix still wins. */}
        <SearchBar chainId={DEFAULT_CHAIN_ID} size="lg" />
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Search an address, a transaction hash, or a block height.
        </p>
      </div>
    </main>
  );
}

function NetworkChip({
  chain,
  testnet = false,
}: {
  chain: ReturnType<typeof getAllChains>[number];
  testnet?: boolean;
}) {
  const accent = accentFor(chain);
  return (
    <Link
      href={`/${chain.chainId}/params`}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground"
      title={chain.chainId}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
      />
      {chain.prettyName}
      {testnet ? (
        <span className="text-[10px] uppercase tracking-wide opacity-60">test</span>
      ) : null}
    </Link>
  );
}
