import type { Pool } from "pg";
import { Rpc } from "./rpc";
import { extractBlock, EXTRACT_VERSION, type ExtractedBlock } from "./extract";
import { missedIn } from "./commit-set";
import { clearGaps, commitBlocks, lowestIndexed, recordGaps, staleHeights } from "./db";

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
  /**
   * A refill that fetches only what needs it: heights in the range with no block,
   * or with one written by an older extractor. For heights an archive refused
   * during a refill (they keep their old rows, and coverage stops at them), and
   * for mending a range cheaply. Implies refill's range walk.
   */
  stale?: boolean;
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
  chainId: string,
  height: number
): Promise<ExtractedBlock | null> {
  const [block, results] = await Promise.all([
    rpc.block(height),
    rpc.blockResults(height),
  ]);
  return extractBlock(block, results, await missedIn(rpc, chainId, block));
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

  if (target.refill || target.stale) {
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

/** What one batch did. */
export type BatchResult =
  /** The floor is reached; nothing left to do. */
  | { status: "done" }
  /** The range was written; `failed` are heights the archive would not serve. */
  | { status: "wrote"; from: number; to: number; written: number; failed: number[] };

/** Fetch one height, retrying a transient failure; null when it still fails. */
async function fetchWithRetry(
  rpc: Rpc,
  chainId: string,
  height: number,
  attempts: number
): Promise<{ block: ExtractedBlock | null; error: string | null }> {
  let error: string | null = null;
  for (let a = 0; a < attempts; a++) {
    try {
      const b = await fetchHeight(rpc, chainId, height);
      if (b) return { block: b, error: null };
      error = "responses disagree or the block is missing";
    } catch (err) {
      error = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500 * (a + 1)));
  }
  return { block: null, error };
}

/**
 * One batch, written oldest-first within the batch.
 *
 * A height the archive will not serve is retried, then RECORDED in block_gap
 * and passed over - never silently skipped. Coverage stops at a recorded gap,
 * and a later refill can target exactly those heights.
 */
export async function backfillOnce(
  pool: Pool,
  target: BackfillTarget,
  options: BackfillOptions = {},
  position?: number
): Promise<BatchResult> {
  const { batchSize, concurrency } = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});
  const rpc = new Rpc(target.rpcUrl);

  const range = await nextRange(pool, target, batchSize, position);
  if (!range) return { status: "done" };

  // Ascending within the batch so the rows land in a natural order.
  let heights: number[] = [];
  if (target.stale) heights = await staleHeights(pool, target.chainId, range.to, range.from, EXTRACT_VERSION);
  else for (let h = range.to; h <= range.from; h++) heights.push(h);
  if (heights.length === 0) return { status: "wrote", from: range.from, to: range.to, written: 0, failed: [] };

  const blocks: ExtractedBlock[] = [];
  const failed: number[] = [];
  let lastError: string | null = null;
  for (let i = 0; i < heights.length; i += concurrency) {
    const slice = heights.slice(i, i + concurrency);
    const fetched = await Promise.all(slice.map((h) => fetchWithRetry(rpc, target.chainId, h, 3)));
    fetched.forEach((f, k) => {
      if (f.block) blocks.push(f.block);
      else {
        failed.push(slice[k]);
        lastError = f.error;
      }
    });
  }

  // Refusals come in bursts (a public archive rate-limiting): the heights that
  // failed get one more round after a pause before they are recorded as gaps -
  // every gap left behind stops coverage until a stale pass re-reads it.
  if (failed.length > 0 && blocks.length > 0) {
    await new Promise((r) => setTimeout(r, 5000));
    const again = await Promise.all(failed.map((h) => fetchWithRetry(rpc, target.chainId, h, 3)));
    const still: number[] = [];
    again.forEach((f, k) => { if (f.block) blocks.push(f.block); else still.push(failed[k]); });
    failed.length = 0;
    failed.push(...still);
    blocks.sort((x, y) => Number(x.block.height) - Number(y.block.height));
  }

  // A whole batch failing is an outage, not a hole: throw, so the caller backs
  // off and retries the same range instead of recording thousands of "gaps" or
  // (as this used to) mistaking an empty batch for the floor and stopping.
  if (blocks.length === 0) {
    throw new Error(`archive served nothing for ${range.to}-${range.from}: ${lastError ?? "unknown"}`);
  }

  // Deliberately not commitBatch: the cursor belongs to the head-follower.
  await commitBlocks(pool, target.chainId, blocks);

  if (failed.length > 0) {
    await recordGaps(pool, target.chainId, failed, `backfill: ${lastError ?? "unavailable"}`.slice(0, 200));
    log(`${target.chainId}: ${failed.length} height(s) in ${range.to}-${range.from} unavailable, recorded as gaps`);
  }
  if (target.refill || target.stale) await clearGaps(pool, target.chainId, range.to, range.from, EXTRACT_VERSION);

  const hollow = blocks.filter((b) => b.abciResultsMissing);
  if (hollow.length > 0) {
    log(
      `${target.chainId}: WARNING ${hollow.length}/${blocks.length} block(s) in ` +
        `${range.to}-${range.from} had transactions but no ABCI results — this ` +
        `archive discards them. Stamped extract_version 0, outside coverage`
    );
  }

  return { status: "wrote", from: range.from, to: range.to, written: blocks.length, failed };
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
  let backoff = 0;
  // Refill walks its own cursor; resume mode re-reads min(height) each pass.
  let position: number | undefined = target.refill || target.stale ? target.from : undefined;

  while (!signal.aborted) {
    let r: BatchResult;
    try {
      r = await backfillOnce(pool, target, options, position);
      backoff = 0;
    } catch (err) {
      // Nothing was committed, so the next pass retries the same range - with a
      // growing pause, since an outage rarely clears in two seconds.
      backoff = Math.min(backoff + 1, 6);
      log(`${target.chainId}: ${(err as Error).message} (retrying in ${2 ** backoff}s)`);
      await sleep(Math.max(throttleMs, 1000 * 2 ** backoff), signal);
      continue;
    }

    if (r.status === "done") {
      if (target.refill || target.stale) {
        log(`${target.chainId}: ${target.stale ? "stale pass" : "refill"} complete down to ${target.floor}`);
      } else {
        const low = await lowestIndexed(pool, target.chainId);
        log(
          `${target.chainId}: backfill complete — history now starts at ${low ?? "?"}`
        );
      }
      return;
    }

    done += r.written;
    // Past the whole range, including any recorded gaps - never re-reading part of
    // it because a few heights failed.
    if (target.refill || target.stale) position = r.to - 1;
    const low = target.refill || target.stale
      ? position
      : await lowestIndexed(pool, target.chainId);
    // Clamped: the final batch overshoots the floor by design, and a negative
    // count in the log reads like a bug rather than the last batch landing.
    const remaining = Math.max(0, (low ?? target.floor) - target.floor);
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

/* The abort listener goes when the timer fires: a follower sleeps between polls
   for days, and a listener left behind by every sleep is a slow leak. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
