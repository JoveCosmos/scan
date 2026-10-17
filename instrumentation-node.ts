import { getAllChains } from "@/lib/chains";
import { getValoperIndex } from "@/lib/gno-valopers";
import { gnoDeploys, gnoPackagePaths } from "@/lib/gno-packages";
import { tokenList } from "@/lib/gno-token-data";
import { gnoNames } from "@/lib/gno-users";
import { govdaoTimeline } from "@/lib/gno-govdao";
import { warmValidators } from "@/lib/warm";
import { getAdapter } from "@/lib/adapter";
import type { ChainConfig } from "@/lib/chains";

/**
 * The Node-only half of instrumentation.ts: warms the slow caches at boot.
 * Kept in its own file so the edge build (which middleware.ts brings in) never
 * bundles it - it reaches Postgres, which needs fs and path.
 */
export function warm() {
  // Cosmos validator lists: the self-bond read is a request per validator, so
  // it is done once here rather than by the first visitor after a deploy.
  for (const chain of getAllChains()) {
    if (chain.kind !== "cosmos") continue;
    const startedAt = Date.now();
    void warmValidators(chain).then(
      () => console.log(`[warm] ${chain.chainId} validators in ${Date.now() - startedAt}ms`),
      (err) =>
        console.warn(`[warm] ${chain.chainId} failed:`, err instanceof Error ? err.message : err)
    );
  }

  for (const chain of getAllChains()) {
    if (chain.kind !== "gno") continue;

    // The package list and who deployed each (one slow indexer scan).
    void gnoPackagePaths(chain);
    void gnoDeploys(chain);
    // GRC20 tokens: their whole history, read once, then followed.
    void tokenList(chain);
    // Registered names (r/sys/users), shown in place of addresses.
    void gnoNames(chain);
    // When each GovDAO proposal was created and executed (two indexer scans).
    void govdaoTimeline(chain);

    // Fire-and-forget: startup must never block on a remote node.
    const startedAt = Date.now();
    void getValoperIndex(chain).then(
      (index) =>
        console.log(
          `[valopers] warmed ${chain.chainId}: ${index.bySigning.size} profiles in ${Date.now() - startedAt}ms`
        ),
      (err) =>
        console.warn(
          `[valopers] warm failed for ${chain.chainId}:`,
          err instanceof Error ? err.message : err
        )
    );
  }

  warmPages();
}

/**
 * Validator pages read at boot, per chain: AtomOne is the one most visited and
 * fully indexed. Kept within the delegations cache's 24 entries (see
 * getDelegations), or the warm-up would evict what it had just read.
 */
function validatorsToWarm(chain: ChainConfig): number {
  if (chain.chainId === "atomone-1") return 12;
  if (chain.kind === "gno") return 10;
  if (chain.chainId === "cosmoshub-4") return 5;
  return chain.tier === "high" || chain.tier === "medium" ? 2 : 0;
}

/**
 * After boot, Scan reads its own most visited pages once: every chain's
 * Overview, validators and proposals, its gno.land and AtomOne sections, and
 * the largest validators' pages. That runs the real code, so every cache a
 * visitor needs is filled before the first visitor comes, not by them (the
 * first Cosmos Hub validator page after a deploy took 4-6 s). Once only: after
 * that, visits keep the pages warm, and each read serves its last value while
 * it refreshes.
 */
function warmPages() {
  setTimeout(async () => {
    const origin =
      process.env.__NEXT_PRIVATE_ORIGIN ?? (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : null);
    if (!origin) return;
    const startedAt = Date.now();
    const lists: string[] = ["/"];
    const details: string[] = [];
    for (const chain of getAllChains()) {
      const id = chain.chainId;
      lists.push(`/${id}/params`, `/${id}/validators`, `/${id}/proposals`);
      if (chain.kind === "gno") lists.push(`/${id}/packages`, `/${id}/tokens`, `/${id}/members`, `/${id}/charts`);
      if (chain.indexed) lists.push(`/${id}/charts`);
      if (chain.photon) lists.push(`/${id}/photon`);
      if (chain.governors) lists.push(`/${id}/governors`);
      const n = validatorsToWarm(chain);
      if (n > 0) {
        const set = await getAdapter(chain)
          .getValidators()
          .catch(() => []);
        for (const v of set.slice(0, n)) details.push(`/${id}/validators/${v.operatorAddress}`);
      }
    }
    const paths = [...new Set([...lists, ...details])];
    let ok = 0;
    // Two at a time: the index has four connections and the visitors come first.
    const queue = [...paths];
    await Promise.all(
      [0, 1].map(async () => {
        for (let path = queue.shift(); path; path = queue.shift()) {
          try {
            const res = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(60_000) });
            // Read to the end: the slow parts of a page stream in after its head.
            await res.arrayBuffer();
            if (res.ok) ok += 1;
          } catch {
            // A page that fails here is simply left for its first visitor.
          }
        }
      })
    );
    console.log(`[warm] ${ok} of ${paths.length} pages in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }, 20_000);
}
