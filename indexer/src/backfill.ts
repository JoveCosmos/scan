import type { Pool } from "pg";
import { Rpc } from "./rpc";
import { extractBlock, type ExtractedBlock } from "./extract";
import { commitBlocks, lowestIndexed } from "./db";

/**
 * Fills history below what the head-follower has reached.
 *
 * Works *downward* from the lowest indexed height toward a floor, so the two
 * processes can run at the same time without coordination: the follower climbs
 * from the head, backfill descends toward genesis, and they meet. Progress is
 * derived from `min(height)` rather than a cursor, which makes a run that dies
 * on day three resume exactly where it stopped.
 *
 * Reads a public archive, never our validator — a genesis backfill is millions
 * of requests and has no business competing with consensus.
 */

export interface BackfillTarget {
  chainId: string;
  /** Archive RPC. Must retain ABCI responses, or the rows come out hollow. */
  rpcUrl: string;
  /** Lowest height to reach. 1 is genesis. */
  floor: number;
  /** Anchor for the first pass when the chain has nothing indexed yet. */
  from?: number;
  /**
   * Re-read heights that are already stored.
   *
   * Resume mode derives its position from `min(height)`, so it can only ever
   * extend history downward — it will not revisit a block it already has. That
   * is right for filling gaps and wrong for the other job: re-extracting a
   * range after the extractor learned something new, such as votes and slash
   * events arriving after a Phase 1 backfill had already run.
   *
   * In refill mode the range is walked from `from` down to `floor` regardless
   * of what is stored, and every write upserts, so the rows gain the new
   * columns without duplicating anything.
   */
  refill?: boolean;
}

export interface BackfillOptions {
  batchSize?: number;
  /** Remote and latency-bound, so higher than the head-follower's. */
  concurrency?: number;
  /** Pause between batches. Public archives are a courtesy, not a right. */
  throttleMs?: number;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  batchSize: 100,
  concurrency: 8,
  throttleMs: 200,
} as const;

async function fetchHeight(
  rpc: Rpc,
  height: number
): Promise<ExtractedBlock | null> {
  const [block, results] = await Promise.all([
    rpc.block(height),
    rpc.blockResults(height),
  ]);
  return extractBlock(block, results);
}

/** Heights still to fill, or null when the floor has been reached. */
export async function nextRange(
  pool: Pool,
  target: BackfillTarget,
  batchSize: number,
  /** Refill's own descending position; resume mode reads the database instead. */
  position?: number
): Promise<{ from: number; to: number } | null> {
  let start: number | null;

  if (target.refill) {
    // Explicit range: ignore what is stored and walk it top-down.
    start = position ?? target.from ?? null;
  } else {
    const lowest = await lowestIndexed(pool, target.chainId);
    // Nothing indexed yet: start just below the anchor the caller gave us.
    const anchor = lowest ?? target.from ?? null;
    start = anchor === null ? null : anchor - 1;
  }

  if (start === null) return null;
  if (start < target.floor) return null;

  // Descending: `to` is the lower bound of this batch.
  const to = Math.max(target.floor, start - batchSize + 1);
  return { from: start, to };
}

/**
 * One batch, written oldest-first within the batch.
 *
 * Returns how many heights were committed; 0 means the floor is reached or the
 * archive could not serve the range.
 */
export async function backfillOnce(
  pool: Pool,
  target: BackfillTarget,
  options: BackfillOptions = {},
  position?: number
): Promise<number> {
  const { batchSize, concurrency } = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});
  const rpc = new Rpc(target.rpcUrl);

  const range = await nextRange(pool, target, batchSize, position);
  if (!range) return 0;

  // Ascending within the batch so the rows land in a natural order.
  const heights: number[] = [];
  for (let h = range.to; h <= range.from; h++) heights.push(h);

  const blocks: ExtractedBlock[] = [];
  for (let i = 0; i < heights.length; i += concurrency) {
    const slice = heights.slice(i, i + concurrency);
    const fetched = await Promise.all(slice.map((h) => fetchHeight(rpc, h)));
    for (const b of fetched) if (b) blocks.push(b);
  }

  if (blocks.length === 0) {
    log(`${target.chainId}: archive served nothing for ${range.to}-${range.from}`);
    return 0;
  }

  // Deliberately not commitBatch: the cursor belongs to the head-follower.
  await commitBlocks(pool, target.chainId, blocks);

  const hollow = blocks.filter((b) => b.abciResultsMissing);
  if (hollow.length > 0) {
    log(
      `${target.chainId}: WARNING ${hollow.length}/${blocks.length} block(s) in ` +
        `${range.to}-${range.from} had transactions but no ABCI results — this ` +
        `archive discards them, so those rows carry no fees or transfers`
    );
  }

  return blocks.length;
}

/** Run batches until the floor is reached or the signal aborts. */
export async function runBackfill(
  pool: Pool,
  target: BackfillTarget,
  options: BackfillOptions,
  signal: AbortSignal
): Promise<void> {
  const { throttleMs } = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});

  const started = Date.now();
  let done = 0;
  // Refill walks its own cursor; resume mode re-reads min(height) each pass.
  let position: number | undefined = target.refill ? target.from : undefined;

  while (!signal.aborted) {
    let written: number;
    try {
      written = await backfillOnce(pool, target, options, position);
    } catch (err) {
      // Nothing was committed, so the next pass retries the same range.
      log(`${target.chainId}: ${(err as Error).message}`);
      await sleep(Math.max(throttleMs, 2000), signal);
      continue;
    }

    if (written === 0) {
      if (target.refill) {
        log(`${target.chainId}: refill complete down to ${target.floor}`);
      } else {
        const low = await lowestIndexed(pool, target.chainId);
        log(
          `${target.chainId}: backfill complete — history now starts at ${low ?? "?"}`
        );
      }
      return;
    }

    done += written;
    if (target.refill && position !== undefined) position -= written;
    const low = target.refill
      ? position
      : await lowestIndexed(pool, target.chainId);
    const remaining = (low ?? target.floor) - target.floor;
    const rate = done / Math.max(1, (Date.now() - started) / 1000);
    const eta = rate > 0 ? remaining / rate : 0;
    log(
      `${target.chainId}: backfilled to ${low} · ${remaining.toLocaleString()} left · ` +
        `${rate.toFixed(0)}/s · eta ${formatDuration(eta)}`
    );

    await sleep(throttleMs, signal);
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
