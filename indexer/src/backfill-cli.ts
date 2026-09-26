import { createPool, lowestIndexed, resolveUnjails } from "./db";
import { runBackfill, type BackfillTarget } from "./backfill";
import { bootstrapKeys } from "./validator-keys";

/**
 * Backfill entry point — a one-off job, not a service.
 *
 * Separate from the head-follower on purpose: it reads a *public archive*
 * rather than our validator, runs at a different concurrency, and finishes
 * instead of looping forever. Both may run at once; they write disjoint height
 * ranges and every write upserts.
 *
 *   DATABASE_URL            postgres://user:pass@127.0.0.1:5433/gata_indexer
 *   BACKFILL_CHAIN          atomone-1
 *   BACKFILL_RPC            https://rpc.atomone-archive.citizenweb3.com
 *   BACKFILL_FLOOR          lowest height to reach (default 1, genesis)
 *   BACKFILL_FROM           anchor; required with BACKFILL_REFILL
 *   BACKFILL_REFILL         1 to re-read a range that is already stored, e.g.
 *                           after the extractor learned to read votes
 *   BACKFILL_CONCURRENCY    default 8
 *   BACKFILL_THROTTLE_MS    pause between batches, default 200
 *   BACKFILL_LCD            optional staking API: seeds validator_key first (genesis
 *                           validators never send MsgCreateValidator), so unjails
 *                           resolve to a consensus address as they are written
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
  if (!url) throw new Error("DATABASE_URL is required");

  const chainId = process.env.BACKFILL_CHAIN;
  const rpcUrl = process.env.BACKFILL_RPC;
  if (!chainId || !rpcUrl) {
    throw new Error("BACKFILL_CHAIN and BACKFILL_RPC are required");
  }

  const target: BackfillTarget = {
    chainId,
    rpcUrl,
    floor: num("BACKFILL_FLOOR", 1),
    from: process.env.BACKFILL_FROM ? num("BACKFILL_FROM", 0) : undefined,
    refill: process.env.BACKFILL_REFILL === "1",
  };

  if (target.refill && target.from === undefined) {
    throw new Error("BACKFILL_REFILL=1 needs BACKFILL_FROM to say where to start");
  }

  const pool = createPool(url);
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received, stopping after this batch`);
      controller.abort();
    });
  }

  const low = await lowestIndexed(pool, chainId);
  if (!target.refill && low === null && target.from === undefined) {
    throw new Error(
      `nothing indexed for ${chainId} yet — set BACKFILL_FROM to a height to start below`
    );
  }

  if (process.env.BACKFILL_LCD) {
    const n = await bootstrapKeys(pool, chainId, process.env.BACKFILL_LCD);
    log(`validator_key: ${n} validators from ${process.env.BACKFILL_LCD}`);
  }

  log(
    target.refill
      ? `refilling ${chainId} from ${target.from} down to ${target.floor} via ${rpcUrl}`
      : `backfilling ${chainId} from ${low ?? target.from} down to ${target.floor} via ${rpcUrl}`
  );

  await runBackfill(
    pool,
    target,
    {
      concurrency: num("BACKFILL_CONCURRENCY", 8),
      throttleMs: num("BACKFILL_THROTTLE_MS", 200),
      batchSize: num("BACKFILL_BATCH", 100),
      log,
    },
    controller.signal
  );

  // Unjails written before their validator's key was known, resolved now.
  const fixed = await resolveUnjails(pool, chainId);
  if (fixed > 0) log(`resolved ${fixed} unjail row(s) to a consensus address`);

  await pool.end();
  log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
