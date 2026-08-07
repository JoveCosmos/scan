import Link from "next/link";
import { redirect } from "next/navigation";
import { SearchX } from "lucide-react";
import { getAllChains, accentFor, type ChainConfig } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { classifyChainless } from "@/lib/search";
import { decodePrefix } from "@/lib/bech32";

export const dynamic = "force-dynamic";
export const metadata = { title: "Search" };

interface Candidate {
  chain: ChainConfig;
  href: string;
  note: string;
}

/** Chains whose bech32 prefix matches — several, since testnets share a prefix. */
function chainsForAddress(address: string): ChainConfig[] {
  const prefix = decodePrefix(address);
  if (!prefix) return [];
  const base = prefix.replace(/(valoper|valcons)$/, "");
  return getAllChains().filter((c) => c.bech32Prefix === base);
}

/** Ask every cosmos chain whether it holds this hash. Only one ever should. */
async function chainsWithTx(query: string): Promise<ChainConfig[]> {
  const candidates = getAllChains();
  const hits = await Promise.all(
    candidates.map(async (chain) => {
      try {
        const tx = await getAdapter(chain).getTx(query);
        return tx ? chain : null;
      } catch {
        return null;
      }
    })
  );
  return hits.filter((c): c is ChainConfig => c !== null);
}

function Disambiguation({
  query,
  candidates,
  hint,
}: {
  query: string;
  candidates: Candidate[];
  hint: string;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Which chain?</h1>
      <p className="mt-2 text-sm text-muted-foreground">{hint}</p>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{query}</p>

      <ul className="mt-6 space-y-2">
        {candidates.map((c) => (
          <li key={c.chain.chainId}>
            <Link
              href={c.href}
              className="gata-panel gata-panel-interactive flex items-center justify-between gap-3 px-5 py-4"
              style={{ ["--panel-accent" as string]: accentFor(c.chain) }}
            >
              <span className="flex items-center gap-2.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: accentFor(c.chain) }}
                />
                <span className="flex flex-col">
                  <span className="font-medium">{c.chain.prettyName}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {c.note}
                  </span>
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {c.chain.network}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

function NoResult({ query }: { query: string }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-20">
      <div className="gata-panel px-6 py-14 text-center">
        <SearchX className="mx-auto h-8 w-8 text-muted-foreground" />
        <h1 className="mt-4 text-lg font-semibold">
          {query ? "Nothing matched that search" : "Enter a search term"}
        </h1>
        {query ? (
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
            {query}
          </p>
        ) : null}
        <p className="mt-4 text-sm text-muted-foreground">
          Try a block height, a transaction hash, or an address from any of the
          chains listed on the home page.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg border border-border bg-secondary/60 px-4 py-2 text-sm transition-colors hover:border-[var(--gata-border-hi)]"
        >
          Back to all chains
        </Link>
      </div>
    </main>
  );
}

/**
 * Chain-agnostic search. An address carries its chain in its prefix, a tx hash
 * has to be looked up, and a height is meaningful on every chain — so this
 * redirects when the answer is unambiguous and asks when it is not.
 *
 * `chain` is a hint from the header on a chain page: if that chain is among the
 * candidates it wins, so searching while viewing Akash stays on Akash.
 */
export default async function GlobalSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; chain?: string }>;
}) {
  const { q = "", chain: hint } = await searchParams;
  const query = q.trim();
  if (!query) return <NoResult query="" />;

  const all = getAllChains();
  // Only heights and hashes are classified here; addresses are resolved from
  // their own prefix a few lines down, against every chain.
  const guess = classifyChainless(query);

  const prefer = (chains: ChainConfig[]) =>
    hint && chains.some((c) => c.chainId === hint)
      ? chains.filter((c) => c.chainId === hint)
      : chains;

  if (guess.kind === "height") {
    const chains = prefer(all);
    if (chains.length === 1) {
      redirect(`/${chains[0].chainId}/blocks/${guess.value}`);
    }
    return (
      <Disambiguation
        query={query}
        hint="That looks like a block height, which exists on every chain."
        candidates={chains.map((chain) => ({
          chain,
          href: `/${chain.chainId}/blocks/${guess.value}`,
          note: `block #${Number(guess.value).toLocaleString()}`,
        }))}
      />
    );
  }

  // An address names its chain family through its prefix.
  const byPrefix = chainsForAddress(query);
  if (byPrefix.length > 0) {
    const isValidator = /valoper/.test(decodePrefix(query) ?? "");
    const path = (c: ChainConfig) =>
      isValidator
        ? `/${c.chainId}/validators/${query}`
        : `/${c.chainId}/accounts/${query}`;

    const chains = prefer(byPrefix);
    if (chains.length === 1) redirect(path(chains[0]));

    return (
      <Disambiguation
        query={query}
        hint="That address is valid on more than one of these chains."
        candidates={chains.map((chain) => ({
          chain,
          href: path(chain),
          note: isValidator ? "validator" : "account",
        }))}
      />
    );
  }

  if (guess.kind === "tx") {
    // Nothing in the hash says which chain it belongs to, so ask them all.
    const found = await chainsWithTx(guess.value);
    if (found.length === 1) {
      redirect(`/${found[0].chainId}/txs/${encodeURIComponent(guess.value)}`);
    }
    if (found.length > 1) {
      return (
        <Disambiguation
          query={query}
          hint="That transaction exists on more than one chain."
          candidates={found.map((chain) => ({
            chain,
            href: `/${chain.chainId}/txs/${encodeURIComponent(guess.value)}`,
            note: "transaction",
          }))}
        />
      );
    }
  }

  return <NoResult query={query} />;
}
