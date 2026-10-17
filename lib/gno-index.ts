import type { Pool } from "pg";
import { getChain } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { coverageOf } from "@/lib/indexer-coverage";
import { indexerPool } from "@/lib/indexer-db";

/**
 * gno.land's messages and GRC20 tokens in our own database (migration 014,
 * docs/INDEXER.md "gno.land messages and GRC20 tokens"), read once their
 * coverage reaches genesis. Until then (before the migration, or while the
 * refill descends) every read here answers null and the callers keep reading
 * the tx-indexer: a partial table would count calls short and give partial,
 * even negative, balances.
 */

export type GnoIndexCapability = "gno_tx_msg" | "gno_grc20";

/** The pool, when `capability` covers the chain from height 0. */
export async function gnoIndexed(chainId: string, capability: GnoIndexCapability): Promise<Pool | null> {
  if (getChain(chainId)?.kind !== "gno") return null;
  const pool = indexerPool();
  if (!pool) return null;
  const cov = await coverageOf(chainId, capability).catch(() => null);
  return cov && cov.lo === 0 ? pool : null;
}

// ── Messages ────────────────────────────────────────────────────────────────

export interface IndexedCall {
  /** Uppercase hex. */
  txHash: string;
  msgIndex: number;
  height: number;
  success: boolean;
  func: string;
  caller: string;
  /** Each argument cut at 200 characters, an ellipsis marking the cut. */
  args: string[] | null;
  time: string | null;
}

/** "k:<height>:<HEX>:<msg index>", the keyset cursor of a realm's calls. */
export function callCursor(c: Pick<IndexedCall, "height" | "txHash" | "msgIndex">): string {
  return `k:${c.height}:${c.txHash}:${c.msgIndex}`;
}

export function parseCallCursor(cursor: string): { height: number; txHash: string; msgIndex: number } | null {
  const m = cursor.match(/^k:(\d+):([0-9A-Fa-f]+):(\d+)$/);
  return m ? { height: Number(m[1]), txHash: m[2], msgIndex: Number(m[3]) } : null;
}

/** A realm's call count and distinct callers. */
export function indexedCallStats(pool: Pool, chainId: string, path: string): Promise<{ total: number; callers: number }> {
  return cached(`gno-db-callstats:${chainId}:${path}`, 60_000, async () => {
    const { rows } = await pool.query<{ total: number; callers: number }>(
      `SELECT count(*)::int AS total, count(DISTINCT caller)::int AS callers
         FROM gno_tx_msg
        WHERE chain_id = $1 AND pkg_path = $2 AND kind = 'call'`,
      [chainId, path]
    );
    return { total: rows[0]?.total ?? 0, callers: rows[0]?.callers ?? 0 };
  }, { staleMs: 10 * 60_000, group: { name: "gno-db-callstats", max: 500 } });
}

/** A page of a realm's calls, newest first, below `before` (a callCursor) when given. */
export async function indexedCalls(
  pool: Pool,
  chainId: string,
  path: string,
  limit: number,
  before?: { height: number; txHash: string; msgIndex: number }
): Promise<{ calls: IndexedCall[]; next: string | null }> {
  const params: unknown[] = [chainId, path, limit + 1];
  let keyset = "";
  if (before) {
    params.push(before.height, before.txHash, before.msgIndex);
    keyset = "AND (m.height, m.tx_hash, m.msg_index) < ($4, $5, $6)";
  }
  const { rows } = await pool.query<{
    tx_hash: string;
    msg_index: number;
    height: string;
    success: boolean;
    func: string | null;
    caller: string | null;
    args: string[] | null;
    time: string | null;
  }>(
    `SELECT m.tx_hash, m.msg_index, m.height::text AS height, m.success, m.func, m.caller, m.args,
            t.time::text AS time
       FROM gno_tx_msg m
       LEFT JOIN gno_tx t ON t.chain_id = m.chain_id AND t.hash = m.tx_hash
      WHERE m.chain_id = $1 AND m.pkg_path = $2 AND m.kind = 'call' ${keyset}
      ORDER BY m.height DESC, m.tx_hash DESC, m.msg_index DESC
      LIMIT $3`,
    params
  );
  const calls = rows.slice(0, limit).map((r) => ({
    txHash: r.tx_hash,
    msgIndex: r.msg_index,
    height: Number(r.height),
    success: r.success,
    func: r.func ?? "",
    caller: r.caller ?? "",
    args: r.args,
    time: r.time,
  }));
  const last = calls.at(-1);
  return { calls, next: rows.length > limit && last ? callCursor(last) : null };
}

/** Every package's first successful deploy: path to deployer, block, transaction and time. */
export async function indexedDeploys(
  pool: Pool,
  chainId: string
): Promise<Map<string, { creator: string; height: number; txHash: string; time: string | null }>> {
  const { rows } = await pool.query<{
    pkg_path: string;
    caller: string | null;
    height: string;
    tx_hash: string;
    time: string | null;
  }>(
    `SELECT DISTINCT ON (m.pkg_path) m.pkg_path, m.caller, m.height::text AS height, m.tx_hash,
            t.time::text AS time
       FROM gno_tx_msg m
       LEFT JOIN gno_tx t ON t.chain_id = m.chain_id AND t.hash = m.tx_hash
      WHERE m.chain_id = $1 AND m.kind = 'addpkg' AND m.success AND m.pkg_path IS NOT NULL
      ORDER BY m.pkg_path, m.height ASC, m.tx_hash ASC`,
    [chainId]
  );
  return new Map(
    rows.map((r) => [
      r.pkg_path,
      { creator: r.caller ?? "", height: Number(r.height), txHash: r.tx_hash, time: r.time },
    ])
  );
}
