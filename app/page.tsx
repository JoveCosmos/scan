import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getAllChains, symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";

export const dynamic = "force-dynamic";

async function ChainCard({
  chainId,
  prettyName,
  accent,
  symbol,
  index,
}: {
  chainId: string;
  prettyName: string;
  accent: string;
  symbol: string;
  index: number;
}) {
  const chain = getAllChains().find((c) => c.chainId === chainId)!;
  const overview = await getAdapter(chain).getOverview();

  return (
    <Link href={`/${chainId}`} className="group block">
      <div
        className="gata-panel gata-panel-interactive gata-rise h-full p-5"
        style={{
          ["--panel-accent" as string]: accent,
          ["--panel-glow" as string]: `${accent}1f`,
          animationDelay: `${index * 70}ms`,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{prettyName}</h2>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {chainId}
            </p>
          </div>
          <span
            className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: accent, boxShadow: `0 0 12px ${accent}` }}
          />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Height
            </p>
            <p className="font-mono text-lg font-semibold">
              {overview.height ? Number(overview.height).toLocaleString() : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Validators
            </p>
            <p className="font-mono text-lg font-semibold">
              {overview.activeValidators ?? "—"}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-border/60 pt-3">
          <span className="text-xs text-muted-foreground">{symbol}</span>
          <span
            className="inline-flex items-center gap-1 text-xs font-medium transition-transform group-hover:translate-x-0.5"
            style={{ color: accent }}
          >
            Explore
            <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </Link>
  );
}

export default function HomePage() {
  const chains = getAllChains();

  return (
    <main className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
      <div className="max-w-2xl">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
          <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
          Live across {chains.length} networks
        </span>

        <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
          <span className="bg-gradient-to-r from-[var(--gata-blue)] to-[var(--gata-cyan)] bg-clip-text text-transparent">
            GATA HUB
          </span>{" "}
          Explorer
        </h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Blocks, transactions and validators across the Cosmos networks GATA
          validates — read straight from full nodes, with no indexer in between.
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {chains.map((chain, i) => (
          <ChainCard
            key={chain.chainId}
            chainId={chain.chainId}
            prettyName={chain.prettyName}
            accent={accentFor(chain)}
            symbol={symbolFor(chain)}
            index={i}
          />
        ))}
      </div>
    </main>
  );
}
