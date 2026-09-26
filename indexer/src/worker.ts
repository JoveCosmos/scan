import type { Pool } from "pg";
import { Rpc } from "./rpc";
import { extractBlock, type ExtractedBlock } from "./extract";
import { missedIn } from "./commit-set";
import { commitBatch, heartbeat, readCursor } from "./db";
import {
  fetchBondedSet,
  writeSnapshot,
  lastSnapshotAt,
  isSnapshotDue,
} from "./stake";

/**
 * Follows one chain's head, writing each committed height into Postgres.
 *
 * Catch-up and steady-state are the same code path — the only difference is how
 * far the cursor trails the head. There is no reorg handling because CometBFT
 * commits are final: once a height is committed it will not change, so an
 * indexed height never needs unwinding.
 */

export interface ChainTarget {
  chainId: string;
  rpcUrl: string;
  /**
   * Staking REST endpoint, for validator stake snapshots. Optional: without it
   * the chain is indexed exactly as before and simply has no snapshots, which
   * is the right behaviour for a chain whose LCD we do not have.
   */
  lcdUrl?: string;
  /** Where to start when the cursor is empty. Defaults to the head. */
  startHeight?: number;
}

export interface WorkerOptions {
  /** Heights per database transaction while catching up. */
  batchSize?: number;
  /** Blocks fetched concurrently. Kept low: this reads our own validator. */
  concurrency?: number;
  /** Pause when already at the head. */
  idleMs?: number;
  /** How often to snapshot the bonded set. */
  snapshotIntervalMs?: number;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  batchSize: 50,
  concurrency: 4,
  idleMs: 3_000,
  // Hourly. The consumer is a 24-hour figure, so finer resolution buys nothing
  // and only makes the table bigger.
  snapshotIntervalMs: 3_600_000,
} as const;

/** Fetch and extract one height. Null when the node cannot serve it. */
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

/**
 * One pass: read the cursor, fetch what is missing up to the head, write it.
 *
 * Returns how many heights were committed, so the caller can decide whether to
 * loop straight away or idle.
 */
export async function indexOnce(
  pool: Pool,
  target: ChainTarget,
  options: WorkerOptions = {}
): Promise<number> {
  const { batchSize, concurrency } = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});
  const rpc = new Rpc(target.rpcUrl);

  const head = await rpc.head();
  const cursor = await readCursor(pool, target.chainId);

  // First run: start where asked, or at the head so a fresh install does not
  // silently try to replay the entire chain.
  const from = cursor === null ? (target.startHeight ?? head) : cursor + 1;
  if (from > head) {
    // At the head with nothing new: say so, or `updated_at` freezes whenever the
    // chain pauses and a reader cannot tell "caught up" from "stuck".
    if (cursor !== null) await heartbeat(pool, target.chainId, head);
    return 0;
  }

  const to = Math.min(head, from + batchSize - 1);
  const heights: number[] = [];
  for (let h = from; h <= to; h++) heights.push(h);

  // Fetched with bounded concurrency but committed in height order, so the
  // cursor always means "everything below this is present".
  const blocks: ExtractedBlock[] = [];
  for (let i = 0; i < heights.length; i += concurrency) {
    const slice = heights.slice(i, i + concurrency);
    const fetched = await Promise.all(slice.map((h) => fetchHeight(rpc, target.chainId, h)));

    for (const b of fetched) {
      // A gap would break the cursor's meaning, so stop the batch here and let
      // the next pass retry this height rather than skipping past it.
      if (!b) {
        log(`height ${slice[fetched.indexOf(b)]} unavailable, stopping batch`);
        break;
      }
      blocks.push(b);
    }
    if (blocks.length !== i + slice.length) break;
  }

  if (blocks.length === 0) return 0;

  await commitBatch(pool, target.chainId, blocks, head);
  const last = blocks[blocks.length - 1].block.height;
  const txs = blocks.reduce((n, b) => n + b.txs.length, 0);
  log(
    `${target.chainId}: +${blocks.length} blocks to ${last} (${txs} txs, head ${head})`
  );

  // Loud on purpose. Hollow rows — transactions with no fee, signer or
  // transfers — look identical to a healthy quiet block in the counts above,
  // so without this a backfill against a node that drops ABCI responses would
  // appear to succeed while writing nothing of use.
  const hollow = blocks.filter((b) => b.abciResultsMissing);
  if (hollow.length > 0) {
    log(
      `${target.chainId}: WARNING ${hollow.length} block(s) had transactions but no ABCI results ` +
        `(${hollow[0].block.height}…): this node discards them. Stamped extract_version 0 - ` +
        `present but incomplete, outside every capability's coverage - until refilled from an archive`
    );
  }

  return blocks.length;
}

/** Run until the signal aborts, idling when caught up. */
export async function runChain(
  pool: Pool,
  target: ChainTarget,
  options: WorkerOptions,
  signal: AbortSignal
): Promise<void> {
  const { idleMs, snapshotIntervalMs } = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});

  while (!signal.aborted) {
    try {
      const written = await indexOnce(pool, target, options);
      // Between batches rather than inside one: a snapshot is independent of
      // any particular height, and folding it into the block transaction would
      // let a slow staking endpoint hold that transaction open.
      await maybeSnapshot(pool, target, snapshotIntervalMs, log);
      if (written === 0) await sleep(idleMs, signal);
    } catch (err) {
      // A node hiccup must not kill the worker; the cursor is unchanged, so the
      // next pass simply retries the same heights.
      log(`${target.chainId}: ${(err as Error).message}`);
      await sleep(idleMs, signal);
    }
  }
}

/**
 * Take a stake snapshot if one is due.
 *
 * Failures are logged and swallowed. Snapshots are a side record; a staking
 * endpoint that is down must never stop the chain being indexed, and a missed
 * snapshot costs one row in a series that is read by nearest-in-time.
 */
async function maybeSnapshot(
  pool: Pool,
  target: ChainTarget,
  intervalMs: number,
  log: (msg: string) => void
): Promise<void> {
  if (!target.lcdUrl) return;

  try {
    const last = await lastSnapshotAt(pool, target.chainId);
    if (!isSnapshotDue(last, new Date(), intervalMs)) return;

    const cursor = await readCursor(pool, target.chainId);
    if (cursor === null) return;

    const rows = await fetchBondedSet(target.lcdUrl);
    // Wall-clock time, matching how the interval is judged and how the figure
    // is asked for — "over 24 hours", not "over 14,400 blocks".
    await writeSnapshot(pool, target.chainId, cursor, new Date().toISOString(), rows);
    log(`${target.chainId}: stake snapshot at ${cursor} (${rows.length} validators)`);
  } catch (err) {
    log(`${target.chainId}: stake snapshot failed - ${(err as Error).message}`);
  }
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
