import type { ChainConfig } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { coverage, indexerPool, poolFor } from "@/lib/indexer-db";
import { coverageOf } from "@/lib/indexer-coverage";
import { heightDaysAgo } from "@/lib/indexer-validator";

export interface DayActivity {
  day: string;
  txs: number;
  /** Distinct fee payers (first signers) that day. */
  signers: number;
  /** Fees paid in the chain's fee denom, base units. */
  fees: string;
}

/**
 * Transactions, active signers and fees per UTC day for the last `days`
 * days, from the index. Read by height from the block `days` ago (the tx
 * table is indexed by height), and cached: the past does not change.
 */
export function dailyActivity(chain: ChainConfig, days = 90): Promise<DayActivity[] | null> {
  if (chain.kind === "gno") return gnoDailyActivity(chain, days);
  const pool = poolFor(chain.chainId);
  if (!pool) return Promise.resolve(null);
  const feeDenom = chain.feeDenom ?? chain.denom;
  return cached(
    `stats-daily:${chain.chainId}:${days}`,
    30 * 60_000,
    async () => {
      const [c, from] = await Promise.all([coverage(chain.chainId, "fees"), heightDaysAgo(chain.chainId, days)]);
      if (!c || from === null) return null;
      const { rows } = await pool.query<{ day: string; txs: number; signers: number; fees: string | null }>(
        `SELECT to_char(date_trunc('day', time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                count(*)::int AS txs,
                count(DISTINCT signer)::int AS signers,
                sum(fee_amount) FILTER (WHERE fee_denom = $3)::text AS fees
           FROM tx
          WHERE chain_id = $1 AND height >= $2
          GROUP BY 1
          ORDER BY 1`,
        [chain.chainId, Math.max(from, c.lowest), feeDenom]
      );
      return rows.map((r) => ({ day: r.day, txs: r.txs, signers: r.signers, fees: r.fees ?? "0" }));
    },
    { staleMs: 6 * 60 * 60_000 }
  ).catch(() => null);
}

/**
 * The same for gno.land, from gno_tx (transactions and fees) and the signer
 * rows of gno_tx_party (role bit 1).
 */
function gnoDailyActivity(chain: ChainConfig, days: number): Promise<DayActivity[] | null> {
  const pool = indexerPool();
  if (!pool) return Promise.resolve(null);
  const feeDenom = chain.feeDenom ?? chain.denom;
  return cached(
    `stats-daily:${chain.chainId}:${days}`,
    30 * 60_000,
    async () => {
      const [c, from] = await Promise.all([coverageOf(chain.chainId, "gno_tx"), heightDaysAgo(chain.chainId, days)]);
      if (!c || from === null) return null;
      const lo = Math.max(from, c.lo);
      const [txs, signers] = await Promise.all([
        pool.query<{ day: string; txs: number; fees: string | null }>(
          `SELECT to_char(date_trunc('day', time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                  count(*)::int AS txs,
                  sum(fee_amount) FILTER (WHERE fee_denom = $3)::text AS fees
             FROM gno_tx
            WHERE chain_id = $1 AND height >= $2 AND time IS NOT NULL
            GROUP BY 1
            ORDER BY 1`,
          [chain.chainId, lo, feeDenom]
        ),
        pool.query<{ day: string; signers: number }>(
          `SELECT to_char(date_trunc('day', t.time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                  count(DISTINCT p.address)::int AS signers
             FROM gno_tx_party p
             JOIN gno_tx t ON t.chain_id = p.chain_id AND t.hash = p.tx_hash
            WHERE p.chain_id = $1 AND p.height >= $2 AND p.roles & 1 <> 0 AND t.time IS NOT NULL
            GROUP BY 1
            ORDER BY 1`,
          [chain.chainId, lo]
        ),
      ]);
      const signersOn = new Map(signers.rows.map((r) => [r.day, r.signers]));
      return txs.rows.map((r) => ({ day: r.day, txs: r.txs, signers: signersOn.get(r.day) ?? 0, fees: r.fees ?? "0" }));
    },
    { staleMs: 6 * 60 * 60_000 }
  ).catch(() => null);
}
