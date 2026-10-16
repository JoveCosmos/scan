import { createPool, readCursor } from "./db";
import { gnoRefill } from "./gno-worker";
import { GNO_EXTRACT_VERSION } from "./gno";

/**
 * gno refill: rewrite a gno chain's stored history at the current GNO_EXTRACT_VERSION. A one-off job, not a
 * service, run beside the follower (it never moves the cursor). Resumable: ranges already at the current version
 * are skipped.
 *
 *   DATABASE_URL             postgres://user:pass@127.0.0.1:5433/gata_indexer
 *   GNO_REFILL_CHAIN         gnoland-1
 *   GNO_REFILL_GRAPHQL       http://127.0.0.1:8547 (the chain's tx-indexer, the one the follower reads)
 *   GNO_REFILL_FROM          highest height to rewrite (default: the chain's cursor)
 *   GNO_REFILL_FLOOR         lowest height (default 0, genesis)
 *   GNO_REFILL_BATCH         heights per range (default 1000)
 *   GNO_REFILL_THROTTLE_MS   pause between ranges (default 500)
 */

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

async function main() {
  const url = process.env.DATABASE_URL;
  const chainId = process.env.GNO_REFILL_CHAIN;
  const graphqlUrl = process.env.GNO_REFILL_GRAPHQL;
  if (!url || !chainId || !graphqlUrl) throw new Error("DATABASE_URL, GNO_REFILL_CHAIN and GNO_REFILL_GRAPHQL are required");

  const pool = createPool(url);
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received, stopping after this range`);
      controller.abort();
    });
  }

  const cursor = await readCursor(pool, chainId);
  const from = num("GNO_REFILL_FROM", cursor ?? -1);
  if (from < 0) throw new Error(`no cursor for ${chainId}: set GNO_REFILL_FROM`);
  const floor = num("GNO_REFILL_FLOOR", 0);
  log(`refilling ${chainId} at gno extract version ${GNO_EXTRACT_VERSION} from ${from} down to ${floor} via ${graphqlUrl}`);

  const r = await gnoRefill(pool, { chainId, graphqlUrl },
    { from, floor, batchSize: num("GNO_REFILL_BATCH", 1000), throttleMs: num("GNO_REFILL_THROTTLE_MS", 500), log },
    controller.signal);
  log(`${controller.signal.aborted ? "stopped" : "done"}: ${r.written} heights rewritten, ${r.skipped} already current`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
