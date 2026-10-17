import Link from "next/link";
import { redirect } from "next/navigation";
import { SearchX } from "lucide-react";
import { getAllChains, accentFor, type ChainConfig } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { classifySearch, secpKeyToAddress } from "@/lib/search";
import { gnoPackagePaths, packageHref, shortPath } from "@/lib/gno-packages";
import { tokenHref } from "@/lib/gno-tokens";
import { tokenList } from "@/lib/gno-token-data";
import { gnoNames } from "@/lib/gno-users";
import { consensusIdsFromPubkey } from "@/lib/uptime";
import { normalizeGnoHash, resolveGnoValidatorAddress } from "@/lib/gno";
import type { ValidatorSummary } from "@/lib/validators";
import { txFromIndex } from "@/lib/indexer-tx";
import { getGovernors, type Governor } from "@/lib/governors";

export const dynamic = "force-dynamic";
export const metadata = { title: "Search" };

interface Candidate {
  chain: ChainConfig;
  href: string;
  note: string;
}

/** Chains whose bech32 prefix matches - several, since testnets share a prefix. */
function chainsForPrefix(prefix: string): ChainConfig[] {
  const base = prefix.replace(/(valoper|valcons)$/, "");
  const chains = getAllChains().filter((c) => c.bech32Prefix === base);
  if (chains.length > 0) return chains;
  // AtomOne governors: atonegov1… belongs to the chains that have them.
  return prefix.endsWith("gov")
    ? getAllChains().filter((c) => c.governors && c.bech32Prefix === prefix.slice(0, -3))
    : [];
}

/** Resolves or gives up within `ms`, so one slow chain cannot stall search. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

/** Active and inactive validators of each chain, from the shared caches. */
async function validatorSets(
  chains: ChainConfig[],
): Promise<{ chain: ChainConfig; validators: ValidatorSummary[] }[]> {
  return Promise.all(
    chains.map(async (chain) => {
      const adapter = getAdapter(chain);
      const [active, inactive] = await Promise.all([
        within(adapter.getValidators(), 8000, [] as ValidatorSummary[]),
        within(adapter.getInactiveValidators(), 8000, [] as ValidatorSummary[]),
      ]);
      return { chain, validators: [...active, ...inactive] };
    }),
  );
}

/**
 * Ask every chain whether it holds this hash. Only one ever should. A gno
 * chain is asked in its own base64 form, so a hex hash copied from gnoscan
 * resolves as well.
 *
 * An indexed chain is asked its index first: the nodes we read from keep a
 * few weeks of transactions, so asking only them could not find anything
 * older, though the transaction's own page (which falls back to the index)
 * showed it. The index answers in milliseconds and warms that page's cache.
 */
async function chainsWithTx(
  hash: string,
): Promise<{ chain: ChainConfig; hash: string }[]> {
  const hits = await Promise.all(
    getAllChains().map(async (chain) => {
      const asked =
        chain.kind === "gno"
          ? normalizeGnoHash(hash)
          : /^[0-9A-F]{64}$/.test(hash)
            ? hash
            : null;
      if (!asked) return null;
      if (chain.kind === "cosmos") {
        const indexed = await within(txFromIndex(chain.chainId, asked), 3000, null);
        if (indexed) return { chain, hash: asked };
      }
      try {
        const tx = await getAdapter(chain).getTx(asked);
        return tx ? { chain, hash: asked } : null;
      } catch {
        return null;
      }
    }),
  );
  return hits.filter(
    (c): c is { chain: ChainConfig; hash: string } => c !== null,
  );
}

function Disambiguation({
  query,
  candidates,
}: {
  query: string;
  candidates: Candidate[];
}) {
  return (
    // The page never scrolls; the list does. `my-auto` on the panel rather than
    // `justify-center` on the page: centring a column taller than its box
    // pushes the top out of reach, which is how nine chains lost their heading
    // and their last rows.
    <main className="mx-auto flex h-full max-w-2xl flex-col px-4 py-4 sm:py-6">
      <div className="my-auto flex max-h-full min-h-0 flex-col">
        {/* Just the question: each option names what was found ("block #1",
            "account"), so the query needs no line of its own. */}
        <h1
          className="font-display shrink-0 text-xl font-semibold tracking-tight"
          title={query}
        >
          Chain?
        </h1>

        <ul className="mt-4 grid min-h-0 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {candidates.map((c) => (
            <li key={c.href}>
              <Link
                href={c.href}
                className="gata-panel gata-panel-interactive flex items-center justify-between gap-3 px-4 py-2.5"
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
      </div>
    </main>
  );
}

function NoResult({ query }: { query: string }) {
  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col px-4 py-4">
      <div className="gata-panel my-auto px-5 py-8 text-center">
        <SearchX className="mx-auto h-8 w-8 text-muted-foreground" />
        <h1 className="mt-4 text-lg font-semibold">
          {query ? "Nothing matched that search" : "Enter a search term"}
        </h1>
        {query ? (
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
            {query}
          </p>
        ) : null}
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
 * has to be looked up, and a height is meaningful on every chain - so this
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
  const shape = classifySearch(query);
  if (shape.kind === "empty") return <NoResult query={query} />;

  const all = getAllChains();
  const prefer = <T extends { chain: ChainConfig }>(items: T[]): T[] =>
    hint && items.some((i) => i.chain.chainId === hint)
      ? items.filter((i) => i.chain.chainId === hint)
      : items;
  // One candidate goes straight there; several ask which chain.
  const settle = (candidates: Candidate[]) => {
    const picked = prefer(candidates);
    if (picked.length === 1) redirect(picked[0].href);
    if (picked.length === 0) return <NoResult query={query} />;
    return <Disambiguation query={query} candidates={picked} />;
  };

  switch (shape.kind) {
    case "height":
      return settle(
        all.map((chain) => ({
          chain,
          href: `/${chain.chainId}/blocks/${shape.value}`,
          note: `block #${Number(shape.value).toLocaleString()}`,
        })),
      );

    case "gnoPath": {
      // Each gno chain that has the package; the same path can live on both.
      const gno = all.filter((c) => c.kind === "gno");
      const lists = await Promise.all(gno.map((c) => within(gnoPackagePaths(c), 3000, null)));
      const render = shape.render ? `?tab=render&render=${encodeURIComponent(shape.render)}` : "";
      return settle(
        gno
          .filter((_, i) => lists[i]?.includes(shape.value))
          .map((chain) => ({ chain, href: `${packageHref(chain.chainId, shape.value)}${render}`, note: shortPath(shape.value) }))
      );
    }

    case "bech32": {
      const chains = chainsForPrefix(shape.prefix);
      if (chains.length === 0) break;
      const address = shape.address;

      if (shape.prefix.endsWith("valcons")) {
        // A consensus address names a validator through its consensus key.
        const sets = await validatorSets(chains);
        return settle(
          sets.flatMap(({ chain, validators }) =>
            validators
              .filter(
                (v) =>
                  v.consensusPubkey &&
                  consensusIdsFromPubkey(v.consensusPubkey, chain.bech32Prefix)
                    ?.valcons === address,
              )
              .map((v) => ({
                chain,
                href: `/${chain.chainId}/validators/${v.operatorAddress}`,
                note: v.moniker,
              })),
          ),
        );
      }

      if (chains[0] && shape.prefix === `${chains[0].bech32Prefix}gov`) {
        return settle(
          chains.map((chain) => ({
            chain,
            href: `/${chain.chainId}/governors/${address}`,
            note: "governor",
          })),
        );
      }

      if (shape.prefix.endsWith("valoper")) {
        return settle(
          chains.map((chain) => ({
            chain,
            href: `/${chain.chainId}/validators/${address}`,
            note: "validator",
          })),
        );
      }

      // On gno a plain address may be a validator's signing or operator
      // address; the registry says which.
      const candidates = await Promise.all(
        chains.map(async (chain) => {
          const validator =
            chain.kind === "gno"
              ? await within(
                  resolveGnoValidatorAddress(chain, address),
                  5000,
                  null,
                )
              : null;
          return validator
            ? {
                chain,
                href: `/${chain.chainId}/validators/${validator}`,
                note: "validator",
              }
            : {
                chain,
                href: `/${chain.chainId}/accounts/${address}`,
                note: "account",
              };
        }),
      );
      return settle(candidates);
    }

    case "txHex":
    case "base64Key32": {
      // 32 base64 bytes are either a gno tx hash or an ed25519 consensus key.
      if (shape.kind === "base64Key32") {
        const sets = await validatorSets(all);
        const byKey = sets.flatMap(({ chain, validators }) =>
          validators
            .filter((v) => v.consensusPubkey === shape.value)
            .map((v) => ({
              chain,
              href: `/${chain.chainId}/validators/${v.operatorAddress}`,
              note: v.moniker,
            })),
        );
        if (byKey.length > 0) return settle(byKey);
      }
      const found = await chainsWithTx(shape.value);
      if (found.length > 0) {
        return settle(
          found.map(({ chain, hash }) => ({
            chain,
            href: `/${chain.chainId}/txs/${encodeURIComponent(hash)}`,
            note: "transaction",
          })),
        );
      }
      break;
    }

    case "secpKey": {
      // An account key maps to an address on every chain; offer each network.
      const byPrefix = new Map<string, ChainConfig[]>();
      for (const chain of all) {
        if (chain.kind === "gno") continue;
        byPrefix.set(chain.bech32Prefix, [
          ...(byPrefix.get(chain.bech32Prefix) ?? []),
          chain,
        ]);
      }
      const candidates: Candidate[] = [];
      for (const [prefix, chains] of byPrefix) {
        const address = secpKeyToAddress(shape.bytes, prefix);
        for (const chain of chains) {
          candidates.push({
            chain,
            href: `/${chain.chainId}/accounts/${address}`,
            note: address,
          });
        }
      }
      return settle(candidates);
    }

    case "consHex": {
      const sets = await validatorSets(all.filter((c) => c.kind === "cosmos"));
      return settle(
        sets.flatMap(({ chain, validators }) =>
          validators
            .filter(
              (v) =>
                v.consensusPubkey &&
                consensusIdsFromPubkey(v.consensusPubkey, chain.bech32Prefix)
                  ?.hex === shape.value,
            )
            .map((v) => ({
              chain,
              href: `/${chain.chainId}/validators/${v.operatorAddress}`,
              note: v.moniker,
            })),
        ),
      );
    }

    case "name": {
      // A validator by name, on any chain. Exact names first.
      const needle = shape.value.toLowerCase();
      const sets = await validatorSets(all);
      const matches = sets.flatMap(({ chain, validators }) =>
        validators
          .filter((v) => v.moniker.toLowerCase().includes(needle))
          .map((v) => ({
            chain,
            href: `/${chain.chainId}/validators/${v.operatorAddress}`,
            note: v.moniker,
            exact: v.moniker.toLowerCase() === needle,
          })),
      );
      // AtomOne governors, by name, on the chains that have them.
      const governorSets = await Promise.all(
        all
          .filter((c) => c.governors)
          .map(async (chain) => ({ chain, governors: await within(getGovernors(chain), 8000, [] as Governor[]) })),
      );
      for (const { chain, governors } of governorSets) {
        for (const g of governors) {
          if (!g.moniker.toLowerCase().includes(needle)) continue;
          matches.push({
            chain,
            href: `/${chain.chainId}/governors/${g.address}`,
            note: `${g.moniker}, governor`,
            exact: g.moniker.toLowerCase() === needle,
          });
        }
      }
      // gno.land accounts by registered name ("@moul" or "moul").
      const bare = needle.replace(/^@/, "");
      const nameSets = await Promise.all(
        all
          .filter((c) => c.kind === "gno")
          .map(async (chain) => ({ chain, names: await within(gnoNames(chain), 1500, null) })),
      );
      for (const { chain, names } of nameSets) {
        for (const [name, address] of names?.byName ?? []) {
          if (!name.includes(bare)) continue;
          // Old names still resolve; the account is listed under its current one.
          if (names!.byAddress.get(address) !== name && name !== bare) continue;
          matches.push({
            chain,
            href: `/${chain.chainId}/accounts/${address}`,
            note: `@${name}`,
            exact: name === bare,
          });
        }
      }
      // gno.land GRC20 tokens, by symbol or name.
      const tokenSets = await Promise.all(
        all
          .filter((c) => c.kind === "gno")
          .map(async (chain) => ({ chain, tokens: await within(tokenList(chain), 1500, null) })),
      );
      for (const { chain, tokens } of tokenSets) {
        for (const t of tokens ?? []) {
          const symbol = t.symbol.toLowerCase();
          if (!symbol.includes(needle) && !t.name.toLowerCase().includes(needle)) continue;
          matches.push({
            chain,
            href: tokenHref(chain.chainId, t),
            note: `${t.name} (${t.symbol}), token`,
            exact: symbol === needle || t.name.toLowerCase() === needle,
          });
        }
      }
      const exact = matches.filter((m) => m.exact);
      const list = (exact.length > 0 ? exact : matches).slice(0, 40);
      if (list.length === 0) break;
      return settle(list);
    }
  }

  return <NoResult query={query} />;
}
