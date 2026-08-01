import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getAllChains, symbolFor, accentFor } from "@/lib/chains";
import { cn } from "@/lib/utils";
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

const TABS = [
  { key: "mainnet", label: "Mainnet" },
  { key: "testnet", label: "Testnet" },
] as const;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ net?: string }>;
}) {
  const { net } = await searchParams;
  const chains = getAllChains();
  const active = net === "testnet" ? "testnet" : "mainnet";
  const visible = chains.filter((c) => c.network === active);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
      <div className="max-w-2xl">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
          <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
          Live across {chains.length} networks
        </span>
      </div>

      {/* Plain links rather than client state: the tab survives a reload and is
          shareable, and the page stays a server component. */}
      <nav className="mt-6 flex items-center gap-1 border-b border-border">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={tab.key === "mainnet" ? "/" : `/?net=${tab.key}`}
              className={cn(
                "relative px-3 py-2.5 text-sm transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-muted-foreground">
                {chains.filter((c) => c.network === tab.key).length}
              </span>
              {isActive ? (
                <span className="absolute inset-x-3 -bottom-px h-px bg-primary shadow-[0_0_8px_var(--gata-glow)]" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((chain, i) => (
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
