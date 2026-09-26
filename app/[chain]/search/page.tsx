import { notFound, redirect } from "next/navigation";
import { getChain } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { classifyQuery } from "@/lib/search";
import { normalizeGnoHash, resolveGnoValidatorAddress } from "@/lib/gno";

export const dynamic = "force-dynamic";

export const metadata = { title: "Search" };

/**
 * Resolves a search term against one chain and redirects. Anything this chain
 * cannot answer — another chain's address, a validator's name, a key, a gno
 * realm path — goes on to the global search, with this chain as the hint that
 * wins when the answer exists here too.
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
    case "tx": {
      // gno hashes are base64; a hex one (gnoscan's form) is converted.
      const hash = chain.kind === "gno" ? (normalizeGnoHash(guess.value) ?? guess.value) : guess.value;
      redirect(`/${chainId}/txs/${encodeURIComponent(hash)}`);
    }
    case "validator":
      redirect(`/${chainId}/validators/${guess.value}`);
    case "address": {
      // On gno a plain address may be a validator's signing or operator address.
      const validator =
        chain.kind === "gno"
          ? await resolveGnoValidatorAddress(chain, guess.value).catch(() => null)
          : (await getAdapter(chain).getValidators().catch(() => [])).some(
                (v) => v.operatorAddress === guess.value
              )
            ? guess.value
            : null;
      redirect(
        validator
          ? `/${chainId}/validators/${validator}`
          : `/${chainId}/accounts/${guess.value}`
      );
    }
  }

  redirect(`/search?${new URLSearchParams({ q: query, chain: chainId })}`);
}
