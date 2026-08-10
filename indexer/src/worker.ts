import type { Pool } from "pg";
import { Rpc } from "./rpc";
import { extractBlock, type ExtractedBlock } from "./extract";
import { commitBatch, readCursor } from "./db";

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
  log?: (msg: string) => void;
}

const DEFAULTS = {
  batchSize: 50,
  concurrency: 4,
  idleMs: 3_000,
} as const;

/** Fetch and extract one height. Null when the node cannot serve it. */
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
  if (from > head) return 0;

  const to = Math.min(head, from + batchSize - 1);
  const heights: number[] = [];
  for (let h = from; h <= to; h++) heights.push(h);

  // Fetched with bounded concurrency but committed in height order, so the
  // cursor always means "everything below this is present".
  const blocks: ExtractedBlock[] = [];
  for (let i = 0; i < heights.length; i += concurrency) {
    const slice = heights.slice(i, i + concurrency);
    const fetched = await Promise.all(slice.map((h) => fetchHeight(rpc, h)));

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

  await commitBatch(pool, target.chainId, blocks);
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
        `(${hollow[0].block.height}…): this node discards them, so those rows have no fees or transfers`
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
  const { idleMs } = { ...DEFAULTS, ...options };
  const log = options.log ?? (() => {});

  while (!signal.aborted) {
    try {
      const written = await indexOnce(pool, target, options);
      if (written === 0) await sleep(idleMs, signal);
    } catch (err) {
      // A node hiccup must not kill the worker; the cursor is unchanged, so the
      // next pass simply retries the same heights.
      log(`${target.chainId}: ${(err as Error).message}`);
      await sleep(idleMs, signal);
    }
  }
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
