/**
 * Runs once when the server boots.
 *
 * The gno.land valopers realm index costs ~95 sequential vm/qrender calls
 * (~15s - the node serialises realm execution, so it cannot be parallelised
 * away). Building it at startup means the validator list is already warm by the
 * time anyone opens it, instead of the first visitor seeing bare addresses
 * while a lazy build runs.
 */
export async function register() {
  // Nothing worth warming during a production build.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Only the Node runtime can read the chain registry off disk. The import
  // sits inside this exact check so the edge build drops it entirely.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warm } = await import("./instrumentation-node");
    warm();
  }
}
