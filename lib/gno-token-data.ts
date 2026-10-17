import type { Pool } from "pg";
import type { ChainConfig } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { gnoIndexed } from "@/lib/gno-index";
import { heightDaysAgo } from "@/lib/indexer-validator";
import { ACCOUNT_TRANSFERS_PAGE, type AccountTransfer, type TokenTransfer } from "@/lib/gno-tokens";

/**
 * GRC20 tokens for the pages, from our index (migration 014): exact holders and
 * balances, kept by the indexer. Every read is null until its gno_grc20
 * coverage reaches genesis.
 */

export interface TokenSummary {
  /** "<realm>.<SYMBOL>.<seq>". */
  key: string;
  realm: string;
  name: string;
  symbol: string;
  decimals: number;
  createdHeight: number;
  /** Uppercase hex; null for a genesis token. */
  createdTx: string | null;
  supply: bigint;
  holders: number;
  transfers: number;
}

const big = (v: string | null | undefined) => {
  try {
    return v ? BigInt(v.split(".")[0]) : BigInt(0);
  } catch {
    return BigInt(0);
  }
};

function indexedList(pool: Pool, chainId: string): Promise<TokenSummary[]> {
  return cached(
    `gno-db-tokens:${chainId}`,
    60_000,
    async () => {
      const [list, counts] = await Promise.all([
        pool.query<{
          token: string;
          realm: string;
          name: string;
          symbol: string;
          decimals: number;
          created_height: string;
          created_tx: string | null;
          holders: string;
          supply: string;
        }>(
          `SELECT t.token, t.realm, t.name, t.symbol, t.decimals, t.created_height::text AS created_height,
                  t.created_tx, count(b.address)::text AS holders, COALESCE(sum(b.balance), 0)::text AS supply
             FROM gno_grc20_token t
             LEFT JOIN gno_grc20_balance b ON b.chain_id = t.chain_id AND b.token = t.token
            WHERE t.chain_id = $1
            GROUP BY t.chain_id, t.token`,
          [chainId]
        ),
        pool.query<{ token: string; transfers: string }>(
          `SELECT token, count(*)::text AS transfers FROM gno_grc20_transfer WHERE chain_id = $1 GROUP BY token`,
          [chainId]
        ),
      ]);
      const transfers = new Map(counts.rows.map((r) => [r.token, Number(r.transfers)]));
      return list.rows.map((r) => ({
        key: r.token,
        realm: r.realm,
        name: r.name,
        symbol: r.symbol,
        decimals: Number(r.decimals) || 0,
        createdHeight: Number(r.created_height),
        createdTx: Number(r.created_height) > 0 ? r.created_tx : null,
        supply: big(r.supply),
        holders: Number(r.holders),
        transfers: transfers.get(r.token) ?? 0,
      }));
    },
    { staleMs: 10 * 60_000 }
  );
}

/** Every token on the chain. */
export async function tokenList(chain: ChainConfig): Promise<TokenSummary[] | null> {
  const pool = await gnoIndexed(chain.chainId, "gno_grc20");
  return pool ? indexedList(pool, chain.chainId).catch(() => null) : null;
}

/** The tokens by key, for naming a transfer's token. */
export async function tokenMeta(chain: ChainConfig): Promise<Map<string, TokenSummary> | null> {
  const list = await tokenList(chain);
  return list ? new Map(list.map((t) => [t.key, t])) : null;
}

/** The token a URL names, by realm and symbol. */
export function findSummary(list: TokenSummary[], realm: string, symbol: string): TokenSummary | null {
  return list.find((t) => t.realm === realm && t.symbol === symbol) ?? null;
}

/** An account's GRC20 balances, with each token's summary. */
export async function accountTokenBalances(
  chain: ChainConfig,
  address: string
): Promise<{ token: TokenSummary; balance: bigint }[] | null> {
  const pool = await gnoIndexed(chain.chainId, "gno_grc20");
  if (!pool) return null;
  try {
    const [list, { rows }] = await Promise.all([
      indexedList(pool, chain.chainId),
      pool.query<{ token: string; balance: string }>(
        `SELECT token, balance::text AS balance FROM gno_grc20_balance
          WHERE chain_id = $1 AND address = $2 AND balance > 0`,
        [chain.chainId, address]
      ),
    ]);
    const byKey = new Map(list.map((t) => [t.key, t]));
    return rows.flatMap((r) => {
      const token = byKey.get(r.token);
      return token ? [{ token, balance: big(r.balance) }] : [];
    });
  } catch {
    return null;
  }
}

/** "k:<height>:<HEX>:<event index>", the keyset cursor of an account's transfers in our index. */
function transferCursor(t: { height: number; txHash: string; eventIndex: number }): string {
  return `k:${t.height}:${t.txHash}:${t.eventIndex}`;
}

function parseTransferCursor(cursor: string): { height: number; txHash: string; eventIndex: number } | null {
  const m = cursor.match(/^k:(\d+):([0-9A-Fa-f]+):(\d+)$/);
  return m ? { height: Number(m[1]), txHash: m[2], eventIndex: Number(m[3]) } : null;
}

/**
 * A page of an account's GRC20 transfers, newest first, by keyset: both
 * sides, a transfer to oneself once. `cursor` is the previous page's `next`;
 * null `next` means the end.
 */
export async function accountTransfersPage(
  chain: ChainConfig,
  address: string,
  cursor?: string
): Promise<{ transfers: AccountTransfer[]; next: string | null } | null> {
  const keyset = cursor ? parseTransferCursor(cursor) : null;
  if (cursor && !keyset) return null;
  const pool = await gnoIndexed(chain.chainId, "gno_grc20");
  if (!pool) return null;
  try {
    const limit = ACCOUNT_TRANSFERS_PAGE;
    const params: unknown[] = [chain.chainId, address, limit + 1];
    let below = "";
    if (keyset) {
      params.push(keyset.height, keyset.txHash, keyset.eventIndex);
      below = "AND (height, tx_hash, event_index) < ($4, $5, $6)";
    }
    const { rows } = await pool.query<{
      height: string;
      tx_hash: string;
      event_index: number;
      token: string;
      from_addr: string;
      to_addr: string;
      amount: string;
    }>(
      `SELECT e.height::text AS height, e.tx_hash, e.event_index, e.token, e.from_addr, e.to_addr,
              e.amount::text AS amount
         FROM ((SELECT height, tx_hash, event_index, token, from_addr, to_addr, amount FROM gno_grc20_transfer
                 WHERE chain_id = $1 AND from_addr = $2 ${below}
                 ORDER BY gno_grc20_transfer.height DESC, tx_hash DESC, event_index DESC LIMIT $3)
               UNION ALL
               (SELECT height, tx_hash, event_index, token, from_addr, to_addr, amount FROM gno_grc20_transfer
                 WHERE chain_id = $1 AND to_addr = $2 AND from_addr <> $2 ${below}
                 ORDER BY gno_grc20_transfer.height DESC, tx_hash DESC, event_index DESC LIMIT $3)) e
        ORDER BY e.height DESC, e.tx_hash DESC, e.event_index DESC
        LIMIT $3`,
      params
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      transfers: page.map((r) => ({
        txHash: r.tx_hash,
        eventIndex: r.event_index,
        height: Number(r.height),
        token: r.token,
        from: r.from_addr,
        to: r.to_addr,
        amount: r.amount.split(".")[0],
      })),
      next:
        rows.length > limit && last
          ? transferCursor({ height: Number(last.height), txHash: last.tx_hash, eventIndex: last.event_index })
          : null,
    };
  } catch {
    return null;
  }
}

/** Holders and transfers on one page of a token's tabs. */
const TOKEN_PAGE = 100;

export interface RankedHolder {
  rank: number;
  address: string;
  balance: bigint;
}

/** "b:<balance>:<address>:<rank>", the keyset cursor of a token's holders (largest first). */
function holderCursor(h: RankedHolder): string {
  return `b:${h.balance}:${h.address}:${h.rank}`;
}

function parseHolderCursor(cursor: string): { balance: string; address: string; rank: number } | null {
  const m = cursor.match(/^b:(\d+):([a-z0-9]+):(\d+)$/);
  return m ? { balance: m[1], address: m[2], rank: Number(m[3]) } : null;
}

/** A page of a token's holders, largest first, ranked; below `cursor` when given. */
export async function tokenHoldersPage(
  chain: ChainConfig,
  key: string,
  cursor?: string
): Promise<{ holders: RankedHolder[]; next: string | null } | null> {
  const below = cursor ? parseHolderCursor(cursor) : null;
  if (cursor && !below) return null;
  const pool = await gnoIndexed(chain.chainId, "gno_grc20");
  if (!pool) return null;
  try {
    const params: unknown[] = [chain.chainId, key, TOKEN_PAGE + 1];
    let keyset = "";
    if (below) {
      params.push(below.balance, below.address);
      keyset = "AND (balance, address) < ($4::numeric, $5)";
    }
    const { rows } = await pool.query<{ address: string; balance: string }>(
      `SELECT address, balance::text AS balance FROM gno_grc20_balance
        WHERE chain_id = $1 AND token = $2 AND balance > 0 ${keyset}
        ORDER BY gno_grc20_balance.balance DESC, address DESC
        LIMIT $3`,
      params
    );
    const start = below ? below.rank + 1 : 1;
    const holders = rows.slice(0, TOKEN_PAGE).map((r, i) => ({ rank: start + i, address: r.address, balance: big(r.balance) }));
    const last = holders.at(-1);
    return { holders, next: rows.length > TOKEN_PAGE && last ? holderCursor(last) : null };
  } catch {
    return null;
  }
}

/** A page of a token's transfers, newest first; below `cursor` (a transferCursor) when given. */
export async function tokenTransfersPage(
  chain: ChainConfig,
  key: string,
  cursor?: string
): Promise<{ transfers: TokenTransfer[]; next: string | null } | null> {
  const below = cursor ? parseTransferCursor(cursor) : null;
  if (cursor && !below) return null;
  const pool = await gnoIndexed(chain.chainId, "gno_grc20");
  if (!pool) return null;
  try {
    const params: unknown[] = [chain.chainId, key, TOKEN_PAGE + 1];
    let keyset = "";
    if (below) {
      params.push(below.height, below.txHash, below.eventIndex);
      keyset = "AND (height, tx_hash, event_index) < ($4, $5, $6)";
    }
    const { rows } = await pool.query<{
      height: string;
      tx_hash: string;
      event_index: number;
      from_addr: string;
      to_addr: string;
      amount: string;
    }>(
      `SELECT height::text AS height, tx_hash, event_index, from_addr, to_addr, amount::text AS amount
         FROM gno_grc20_transfer
        WHERE chain_id = $1 AND token = $2 ${keyset}
        ORDER BY gno_grc20_transfer.height DESC, tx_hash DESC, event_index DESC
        LIMIT $3`,
      params
    );
    const page = rows.slice(0, TOKEN_PAGE);
    const last = page.at(-1);
    return {
      transfers: page.map((r) => ({
        txHash: r.tx_hash,
        eventIndex: r.event_index,
        height: Number(r.height),
        from: r.from_addr,
        to: r.to_addr,
        amount: big(r.amount),
      })),
      next:
        rows.length > TOKEN_PAGE && last
          ? transferCursor({ height: Number(last.height), txHash: last.tx_hash, eventIndex: last.event_index })
          : null,
    };
  } catch {
    return null;
  }
}

// ── Activity ────────────────────────────────────────────────────────────────

/** Each token's transfers in the last 24 hours, by key (a token with none is absent). */
export function tokenTransfers24h(chain: ChainConfig): Promise<Map<string, number> | null> {
  return cached(
    `gno-db-token-24h:${chain.chainId}`,
    5 * 60_000,
    async () => {
      // Two days back by height bounds the scan; the transaction time cuts it to 24 hours.
      const [pool, from] = await Promise.all([gnoIndexed(chain.chainId, "gno_grc20"), heightDaysAgo(chain.chainId, 2)]);
      if (!pool || from === null) return null;
      const { rows } = await pool.query<{ token: string; transfers: number }>(
        `SELECT g.token, count(*)::int AS transfers
           FROM gno_grc20_transfer g
           JOIN gno_tx t ON t.chain_id = g.chain_id AND t.hash = g.tx_hash
          WHERE g.chain_id = $1 AND g.height >= $2 AND t.time >= now() - interval '24 hours'
          GROUP BY g.token`,
        [chain.chainId, from]
      );
      return new Map(rows.map((r) => [r.token, r.transfers]));
    },
    { staleMs: 30 * 60_000 }
  ).catch(() => null);
}

/** One token's transfers per UTC day over the last `days` days. */
export function tokenDailyTransfers(
  chain: ChainConfig,
  key: string,
  days = 90
): Promise<{ day: string; transfers: number }[] | null> {
  return cached(
    `gno-db-token-daily:${chain.chainId}:${key}:${days}`,
    30 * 60_000,
    async () => {
      const [pool, from] = await Promise.all([gnoIndexed(chain.chainId, "gno_grc20"), heightDaysAgo(chain.chainId, days)]);
      if (!pool || from === null) return null;
      const { rows } = await pool.query<{ day: string; transfers: number }>(
        `SELECT to_char(date_trunc('day', t.time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS transfers
           FROM gno_grc20_transfer g
           JOIN gno_tx t ON t.chain_id = g.chain_id AND t.hash = g.tx_hash
          WHERE g.chain_id = $1 AND g.token = $2 AND g.height >= $3 AND t.time IS NOT NULL
          GROUP BY 1
          ORDER BY 1`,
        [chain.chainId, key, from]
      );
      return rows;
    },
    { staleMs: 6 * 60 * 60_000, group: { name: "gno-db-token-daily", max: 100 } }
  ).catch(() => null);
}
