import type { Pool } from "pg";
import { extractGno, GnoSource, type GnoExtracted } from "./gno";
import { readCursor, recordGaps } from "./db";

/**
 * The gno follower: one loop per gno chain, reading the chain's tx-indexer by
 * height range and writing block, gno_tx and gno_tx_party.
 *
 * A fresh cursor starts at genesis and walks up. gno chains are small (a few
 * hundred thousand blocks, tens of thousands of transactions) and the
 * tx-indexer is local, so the whole history arrives in minutes; there is no
 * separate descending backfill as there is for Cosmos chains.
 *
 * Freshness is the same contract as the Cosmos follower's: every committed batch
 * moves indexer_cursor.updated_at, and so does a heartbeat while it is at the
 * tx-indexer's head - but only while the tx-indexer itself is within a few
 * blocks of the node, so a stalled tx-indexer shows as a stale cursor, not as a
 * fresh one with nothing new. head_height is the node's.
 */

export interface GnoTarget {
  chainId: string;
  graphqlUrl: string;
  /** A node's RPC for the chain's real head (a non-validating one). */
  rpcUrl?: string;
}

export interface GnoOptions {
  batchSize?: number;
  idleMs?: number;
  /** How far the tx-indexer may trail the node and still count as at the head. */
  maxIndexerLag?: number;
  log?: (msg: string) => void;
}

const DEFAULTS = { batchSize: 1000, idleMs: 2000, maxIndexerLag: 10 };

async function nodeStatus(rpcUrl: string): Promise<{ network: string; height: number }> {
  const res = await fetch(rpcUrl.replace(/\/$/, "") + "/status", { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`node responded ${res.status}`);
  const body = (await res.json()) as { result?: { node_info?: { network?: string }; sync_info?: { latest_block_height?: string } } };
  return { network: body.result?.node_info?.network ?? "", height: Number(body.result?.sync_info?.latest_block_height ?? 0) };
}

/** One range, written as one transaction with the cursor. */
export async function commitGno(pool: Pool, chainId: string, x: GnoExtracted, last: number, head: number | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (x.blocks.length) {
      // gno-signatures writes gnoland-1's blocks too (proposer, at version 3): this
      // never lowers a version and never replaces a proposer it recorded.
      await client.query(
        `INSERT INTO block (chain_id, height, time, proposer_cons, hash, tx_count, extract_version)
         SELECT $1, t.h, t.tm, NULL, t.hs, t.n, t.v
           FROM unnest($2::bigint[], $3::timestamptz[], $4::text[], $5::int[], $6::smallint[]) AS t(h, tm, hs, n, v)
         ON CONFLICT (chain_id, height) DO UPDATE SET
           time = EXCLUDED.time,
           hash = COALESCE(EXCLUDED.hash, block.hash),
           tx_count = EXCLUDED.tx_count,
           extract_version = GREATEST(block.extract_version, EXCLUDED.extract_version)`,
        [chainId, x.blocks.map((b) => b.height), x.blocks.map((b) => b.time), x.blocks.map((b) => b.hash),
         x.blocks.map((b) => b.txCount), x.blocks.map((b) => b.version)]
      );
    }
    if (x.txs.length) {
      await client.query(
        `INSERT INTO gno_tx (chain_id, hash, height, tx_index, time, success, gas_wanted, gas_used, fee_amount, fee_denom,
                             msg_types, memo, error)
         SELECT $1, t.hash, t.height, t.idx, t.time, t.ok, t.gw, t.gu, t.fa, t.fd,
                ARRAY(SELECT jsonb_array_elements_text(t.types::jsonb)), t.memo, t.err
           FROM unnest($2::text[], $3::bigint[], $4::int[], $5::timestamptz[], $6::boolean[], $7::bigint[], $8::bigint[],
                       $9::numeric[], $10::text[], $11::text[], $12::text[], $13::text[])
             AS t(hash, height, idx, time, ok, gw, gu, fa, fd, types, memo, err)
         ON CONFLICT (chain_id, hash) DO UPDATE SET
           height = EXCLUDED.height, tx_index = EXCLUDED.tx_index, time = EXCLUDED.time, success = EXCLUDED.success,
           gas_wanted = EXCLUDED.gas_wanted, gas_used = EXCLUDED.gas_used, fee_amount = EXCLUDED.fee_amount,
           fee_denom = EXCLUDED.fee_denom, msg_types = EXCLUDED.msg_types, memo = EXCLUDED.memo, error = EXCLUDED.error`,
        [chainId, x.txs.map((t) => t.hash), x.txs.map((t) => t.height), x.txs.map((t) => t.txIndex), x.txs.map((t) => t.time),
         x.txs.map((t) => t.success), x.txs.map((t) => t.gasWanted), x.txs.map((t) => t.gasUsed), x.txs.map((t) => t.feeAmount),
         x.txs.map((t) => t.feeDenom), x.txs.map((t) => JSON.stringify(t.msgTypes)), x.txs.map((t) => t.memo), x.txs.map((t) => t.error)]
      );
    }
    if (x.parties.length) {
      // Only really new rows reach address_tx_count (the trigger counts inserts, not
      // the updates a re-read makes).
      await client.query(
        `INSERT INTO gno_tx_party (chain_id, address, height, tx_hash, roles)
         SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::int[])
         ON CONFLICT (chain_id, address, height, tx_hash) DO UPDATE SET roles = EXCLUDED.roles`,
        [chainId, x.parties.map((p) => p.address), x.parties.map((p) => p.height), x.parties.map((p) => p.txHash),
         x.parties.map((p) => p.roles)]
      );
    }
    await client.query(
      `INSERT INTO indexer_cursor (chain_id, last_height, updated_at, head_height)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (chain_id) DO UPDATE SET
         last_height = GREATEST(indexer_cursor.last_height, EXCLUDED.last_height),
         updated_at = now(),
         head_height = COALESCE(EXCLUDED.head_height, indexer_cursor.head_height)`,
      [chainId, last, head]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One step: the next range if there is one, else a heartbeat. Returns heights written. */
export async function gnoOnce(pool: Pool, target: GnoTarget, src: GnoSource, opts: GnoOptions = {}): Promise<number> {
  const { batchSize, maxIndexerLag } = { ...DEFAULTS, ...opts };
  const log = opts.log ?? (() => {});
  const indexed = await src.latest();
  const node = target.rpcUrl ? await nodeStatus(target.rpcUrl).catch(() => null) : null;
  const head = node ? node.height : indexed;
  const cur = (await readCursor(pool, target.chainId)) ?? 0;

  if (cur >= indexed) {
    if (indexed >= head - maxIndexerLag) {
      await pool.query(
        `UPDATE indexer_cursor SET updated_at = now(), head_height = $3 WHERE chain_id = $1 AND last_height >= $2`,
        [target.chainId, indexed, head]
      );
    }
    return 0;
  }

  const lo = cur + 1, hi = Math.min(indexed, cur + batchSize);
  const [blocks, txs] = await Promise.all([src.blocks(lo, hi), src.txs(lo, hi)]);
  const x = extractGno(blocks, txs);
  const have = new Set(blocks.map((b) => b.height)), missing: number[] = [];
  for (let h = lo; h <= hi; h++) if (!have.has(h)) missing.push(h);
  await commitGno(pool, target.chainId, x, hi, head);
  if (missing.length) {
    await recordGaps(pool, target.chainId, missing, "gno: the tx-indexer has no block");
    log(`${target.chainId}: ${missing.length} height(s) in ${lo}-${hi} missing from the tx-indexer, recorded as gaps`);
  }
  if (x.hollow.length) {
    log(`${target.chainId}: ${x.hollow.length} block(s) in ${lo}-${hi} with fewer transactions than num_txs - written hollow (version 0)`);
  }
  log(`${target.chainId}: +${hi - lo + 1} blocks to ${hi} (${x.txs.length} txs, ${x.parties.length} parties, head ${head})`);
  return hi - lo + 1;
}

/** Follow one gno chain until the signal aborts. */
export async function runGno(pool: Pool, target: GnoTarget, opts: GnoOptions, signal: AbortSignal): Promise<void> {
  const { idleMs } = { ...DEFAULTS, ...opts };
  const log = opts.log ?? (() => {});
  const src = new GnoSource(target.graphqlUrl);

  // Never point a chain id at the wrong service: both ends must say which chain they serve.
  const served = await src.chainId();
  if (served !== target.chainId) throw new Error(`${target.graphqlUrl} serves ${served}, not ${target.chainId}`);
  if (target.rpcUrl) {
    const n = await nodeStatus(target.rpcUrl);
    if (n.network !== target.chainId) throw new Error(`${target.rpcUrl} serves ${n.network}, not ${target.chainId}`);
  }
  await src.init();
  log(`${target.chainId}: gno follower on ${target.graphqlUrl}${target.rpcUrl ? `, head from ${target.rpcUrl}` : ""}`);

  let backoff = idleMs;
  while (!signal.aborted) {
    try {
      const n = await gnoOnce(pool, target, src, opts);
      backoff = idleMs;
      if (n === 0) await sleep(idleMs, signal);
    } catch (err) {
      log(`${target.chainId}: ${err instanceof Error ? err.message : String(err)} - retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
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
