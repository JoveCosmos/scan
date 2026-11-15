import type { Pool } from "pg";
import { extractGno, GnoSource, GNO_EXTRACT_VERSION, type GnoExtracted } from "./gno";
import { readCursor, recordGaps } from "./db";

/**
 * The gno follower: one loop per gno chain, reading the chain's tx-indexer by
 * height range and writing block, gno_tx, gno_tx_party, gno_tx_msg and the
 * GRC20 tokens and transfers (the database keeps the balances).
 *
 * A fresh cursor starts at genesis (height 0, which holds the genesis
 * transactions) and walks up. gno chains are small (a few hundred thousand
 * blocks, tens of thousands of transactions) and the tx-indexer is local, so the
 * whole history arrives in minutes. History already stored is rewritten at a new
 * GNO_EXTRACT_VERSION by gnoRefill (gno-refill-cli.ts), which never moves the
 * cursor.
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

/** Last occurrence wins, by key: one row per conflict target per statement. */
function lastBy<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

export interface CommitGnoOptions {
  /** false for a refill: the rows are rewritten and the cursor stays where the follower left it. */
  cursor?: boolean;
}

/** One range, written as one transaction (with the cursor, unless a refill says otherwise). */
export async function commitGno(pool: Pool, chainId: string, x: GnoExtracted, last: number, head: number | null,
                                opts: CommitGnoOptions = {}): Promise<void> {
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
    const hashes = x.txs.map((t) => t.hash);

    // gno_tx_msg: a transaction's messages are replaced together, so a rewrite never leaves one behind.
    if (hashes.length) await client.query(`DELETE FROM gno_tx_msg WHERE chain_id = $1 AND tx_hash = ANY($2::text[])`, [chainId, hashes]);
    const msgs = lastBy(x.msgs, (m) => `${m.txHash}|${m.msgIndex}`);
    if (msgs.length) {
      await client.query(
        `INSERT INTO gno_tx_msg (chain_id, tx_hash, msg_index, height, success, kind, pkg_path, func, caller, args, coins, ugnot)
         SELECT $1, t.h, t.i, t.ht, t.ok, t.k, t.p, t.f, t.c,
                CASE WHEN t.a IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(t.a::jsonb)) END, t.cn, t.u
           FROM unnest($2::text[], $3::int[], $4::bigint[], $5::boolean[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
                       $11::text[], $12::numeric[])
             AS t(h, i, ht, ok, k, p, f, c, a, cn, u)
         ON CONFLICT (chain_id, tx_hash, msg_index) DO UPDATE SET
           height = EXCLUDED.height, success = EXCLUDED.success, kind = EXCLUDED.kind, pkg_path = EXCLUDED.pkg_path,
           func = EXCLUDED.func, caller = EXCLUDED.caller, args = EXCLUDED.args, coins = EXCLUDED.coins, ugnot = EXCLUDED.ugnot`,
        [chainId, msgs.map((m) => m.txHash), msgs.map((m) => m.msgIndex), msgs.map((m) => m.height), msgs.map((m) => m.success),
         msgs.map((m) => m.kind), msgs.map((m) => m.pkgPath), msgs.map((m) => m.func), msgs.map((m) => m.caller),
         msgs.map((m) => (m.args ? JSON.stringify(m.args) : null)), msgs.map((m) => m.coins), msgs.map((m) => m.ugnot)]
      );
    }

    const tokens = lastBy(x.tokens, (t) => t.token);
    if (tokens.length) {
      await client.query(
        `INSERT INTO gno_grc20_token (chain_id, token, realm, name, symbol, decimals, created_height, created_tx)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::bigint[], $8::text[])
         ON CONFLICT (chain_id, token) DO UPDATE SET
           realm = EXCLUDED.realm, name = EXCLUDED.name, symbol = EXCLUDED.symbol, decimals = EXCLUDED.decimals,
           created_height = EXCLUDED.created_height, created_tx = EXCLUDED.created_tx`,
        [chainId, tokens.map((t) => t.token), tokens.map((t) => t.realm), tokens.map((t) => t.name), tokens.map((t) => t.symbol),
         tokens.map((t) => t.decimals), tokens.map((t) => t.height), tokens.map((t) => t.txHash)]
      );
    }

    // gno_grc20_transfer: upserted, and a row changes only when its event did, so the balance triggers move only what
    // changed (a refill re-reading history moves nothing). A row the transaction no longer yields is removed.
    const transfers = lastBy(x.transfers, (t) => `${t.txHash}|${t.eventIndex}`);
    if (hashes.length) {
      await client.query(
        `DELETE FROM gno_grc20_transfer g
          WHERE g.chain_id = $1 AND g.tx_hash = ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::int[]) AS k(h, i) WHERE k.h = g.tx_hash AND k.i = g.event_index)`,
        [chainId, hashes, transfers.map((t) => t.txHash), transfers.map((t) => t.eventIndex)]
      );
    }
    if (transfers.length) {
      await client.query(
        `INSERT INTO gno_grc20_transfer AS g (chain_id, height, tx_hash, event_index, token, from_addr, to_addr, amount)
         SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::numeric[])
         ON CONFLICT (chain_id, tx_hash, event_index) DO UPDATE SET
           height = EXCLUDED.height, token = EXCLUDED.token, from_addr = EXCLUDED.from_addr, to_addr = EXCLUDED.to_addr,
           amount = EXCLUDED.amount
         WHERE (g.height, g.token, g.from_addr, g.to_addr, g.amount)
               IS DISTINCT FROM (EXCLUDED.height, EXCLUDED.token, EXCLUDED.from_addr, EXCLUDED.to_addr, EXCLUDED.amount)`,
        [chainId, transfers.map((t) => t.height), transfers.map((t) => t.txHash), transfers.map((t) => t.eventIndex),
         transfers.map((t) => t.token), transfers.map((t) => t.from), transfers.map((t) => t.to), transfers.map((t) => t.amount)]
      );
    }

    if (opts.cursor !== false) {
      await client.query(
        `INSERT INTO indexer_cursor (chain_id, last_height, updated_at, head_height)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (chain_id) DO UPDATE SET
           last_height = GREATEST(indexer_cursor.last_height, EXCLUDED.last_height),
           updated_at = now(),
           head_height = COALESCE(EXCLUDED.head_height, indexer_cursor.head_height)`,
        [chainId, last, head]
      );
    }
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
  // No cursor yet: start at genesis, height 0.
  const cur = (await readCursor(pool, target.chainId)) ?? -1;

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

export interface GnoRefillOptions {
  /** Highest height to rewrite; the follower's cursor when it starts, so the two never overlap. */
  from: number;
  /** Lowest height, genesis (0) by default. */
  floor?: number;
  /** Heights per range (two GraphQL reads, one database transaction). */
  batchSize?: number;
  /** Pause between ranges: the tx-indexer is the follower's too. */
  throttleMs?: number;
  log?: (msg: string) => void;
  /** The tx-indexer to read; one for target.graphqlUrl by default (tests pass their own). */
  source?: GnoSource;
}

/**
 * Rewrite a gno chain's stored history at the current GNO_EXTRACT_VERSION, from `from` down to `floor`.
 *
 * Downwards, like the Cosmos refills, so a new capability's coverage grows from the head as it runs. A range whose
 * blocks all carry the current version already is skipped without a read, so a stopped refill resumes where it left
 * off. One request at a time, with a pause after each. The cursor is never touched: the follower owns it and keeps
 * writing new heights above `from` meanwhile.
 */
export async function gnoRefill(pool: Pool, target: GnoTarget, opts: GnoRefillOptions, signal: AbortSignal):
    Promise<{ written: number; skipped: number }> {
  const floor = Math.max(0, opts.floor ?? 0);
  const batchSize = Math.max(1, opts.batchSize ?? 1000);
  const throttleMs = opts.throttleMs ?? 500;
  const log = opts.log ?? (() => {});
  const src = opts.source ?? new GnoSource(target.graphqlUrl);
  const served = await src.chainId();
  if (served !== target.chainId) throw new Error(`${target.graphqlUrl} serves ${served}, not ${target.chainId}`);
  await src.init();

  let hi = opts.from, written = 0, skipped = 0, backoff = 2000;
  while (hi >= floor && !signal.aborted) {
    const lo = Math.max(floor, hi - batchSize + 1);
    const done = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM block WHERE chain_id = $1 AND height BETWEEN $2 AND $3 AND extract_version >= $4`,
      [target.chainId, lo, hi, GNO_EXTRACT_VERSION]);
    if (done.rows[0].n === hi - lo + 1) { skipped += hi - lo + 1; hi = lo - 1; continue; }
    try {
      const blocks = await src.blocks(lo, hi);
      await sleep(throttleMs, signal);
      const txs = await src.txs(lo, hi);
      const x = extractGno(blocks, txs);
      await commitGno(pool, target.chainId, x, hi, null, { cursor: false });
      const have = new Set(blocks.map((b) => b.height)), missing: number[] = [];
      for (let h = lo; h <= hi; h++) if (!have.has(h)) missing.push(h);
      if (missing.length) await recordGaps(pool, target.chainId, missing, "gno: the tx-indexer has no block");
      written += hi - lo + 1;
      log(`${target.chainId}: refilled ${lo}-${hi} (${x.txs.length} txs, ${x.msgs.length} messages, ${x.transfers.length} token transfers` +
          `${x.hollow.length ? `, ${x.hollow.length} hollow` : ""}${missing.length ? `, ${missing.length} missing` : ""})`);
      hi = lo - 1;
      backoff = 2000;
      await sleep(throttleMs, signal);
    } catch (err) {
      log(`${target.chainId}: ${lo}-${hi}: ${err instanceof Error ? err.message : String(err)} - retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
  return { written, skipped };
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
