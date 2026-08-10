import Link from "next/link";
import { Server } from "lucide-react";
import { getAllChains, accentFor } from "@/lib/chains";
import { SearchBar } from "@/components/search-bar";
import { hasServices } from "@/lib/services";

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
          <NetworkChip key={chain.chainId} chain={chain} />
        ))}
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

      {/* Only once something is actually published, so the button never leads
          to an empty page. */}
      {hasServices() ? (
        <Link
          href="/public-goods"
          className="gata-panel gata-panel-interactive mt-10 inline-flex items-center gap-2 px-4 py-2.5 text-sm transition-colors hover:border-[var(--gata-border-hi)]"
        >
          <Server className="h-4 w-4 text-muted-foreground" />
          Public goods
          <span className="text-xs text-muted-foreground">
            endpoints, snapshots, peers
          </span>
        </Link>
      ) : null}
    </main>
  );
}

function NetworkChip({ chain }: { chain: ReturnType<typeof getAllChains>[number] }) {
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
      {/* No "test" badge: every testnet already says so in its name. */}
      {chain.prettyName}
    </Link>
  );
}
