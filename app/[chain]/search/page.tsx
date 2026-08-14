import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SearchX } from "lucide-react";
import { getChain } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { classifyQuery } from "@/lib/search";

export const dynamic = "force-dynamic";

export const metadata = { title: "Search" };

/**
 * Resolves a search term server-side and redirects, so the input can stay dumb
 * and the ambiguous cases (an address that may be a validator or an account)
 * are settled against the chain rather than guessed in the browser.
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { chain: chainId } = await params;
  const { q = "" } = await searchParams;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const query = q.trim();
  const guess = classifyQuery(chain, query);

  switch (guess.kind) {
    case "height":
      redirect(`/${chainId}/blocks/${guess.value}`);
    case "tx":
      redirect(`/${chainId}/txs/${encodeURIComponent(guess.value)}`);
    case "validator":
      redirect(`/${chainId}/validators/${guess.value}`);
    case "address": {
      // On gno a plain address may be a consensus validator; only the validator
      // set can tell us, so ask before choosing a destination.
      const validators = await getAdapter(chain)
        .getValidators()
        .catch(() => []);
      const isValidator = validators.some((v) => v.operatorAddress === guess.value);
      redirect(
        isValidator
          ? `/${chainId}/validators/${guess.value}`
          : `/${chainId}/accounts/${guess.value}`
      );
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-20">
      <div className="gata-panel px-5 py-10 text-center">
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
          Try a block height, a transaction hash, or an address starting with{" "}
          <span className="font-mono">{chain.bech32Prefix}</span>.
        </p>
        <Link
          href={`/${chainId}`}
          className="mt-6 inline-block rounded-lg border border-border bg-secondary/60 px-4 py-2 text-sm transition-colors hover:border-[var(--gata-border-hi)]"
        >
          Back to {chain.prettyName}
        </Link>
      </div>
    </main>
  );
}
