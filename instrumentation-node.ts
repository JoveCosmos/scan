import { getAllChains } from "@/lib/chains";
import { getValoperIndex } from "@/lib/gno-valopers";
import { gnoDeploys, gnoPackagePaths } from "@/lib/gno-packages";
import { gnoTokens } from "@/lib/gno-tokens";
import { govdaoTimeline } from "@/lib/gno-govdao";
import { warmValidators } from "@/lib/warm";

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
    void gnoTokens(chain);
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
}
