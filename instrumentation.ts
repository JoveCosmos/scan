/**
 * Runs once when the server boots.
 *
 * The gno.land valopers realm index costs ~95 sequential vm/qrender calls
 * (~15s — the node serialises realm execution, so it cannot be parallelised
 * away). Building it at startup means the validator list is already warm by the
 * time anyone opens it, instead of the first visitor seeing bare addresses
 * while a lazy build runs.
 */
export async function register() {
  // Only the Node runtime can read the chain registry off disk, and there is
  // nothing worth warming during a production build.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const [{ getAllChains }, { getValoperIndex }] = await Promise.all([
    import("@/lib/chains"),
    import("@/lib/gno-valopers"),
  ]);

  for (const chain of getAllChains()) {
    if (chain.kind !== "gno") continue;

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
