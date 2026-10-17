import type { Pool } from "pg";
import type { ChainConfig } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { gnoIndexed } from "@/lib/gno-index";
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

/** A token's holders, largest first. */
export async function tokenHolders(
  chain: ChainConfig,
  key: string,
  limit = 500
): Promise<{ address: string; balance: bigint }[] | null> {
  const pool = await gnoIndexed(chain.chainId, "gno_grc20");
  if (!pool) return null;
  try {
    const { rows } = await pool.query<{ address: string; balance: string }>(
      `SELECT address, balance::text AS balance FROM gno_grc20_balance
        WHERE chain_id = $1 AND token = $2 AND balance > 0
        ORDER BY gno_grc20_balance.balance DESC
        LIMIT $3`,
      [chain.chainId, key, limit]
    );
    return rows.map((r) => ({ address: r.address, balance: big(r.balance) }));
  } catch {
    return null;
  }
}

/** A token's latest transfers, newest first. */
export async function tokenRecent(chain: ChainConfig, key: string, limit = 300): Promise<TokenTransfer[] | null> {
  const pool = await gnoIndexed(chain.chainId, "gno_grc20");
  if (!pool) return null;
  try {
    const { rows } = await pool.query<{
      height: string;
      tx_hash: string;
      from_addr: string;
      to_addr: string;
      amount: string;
    }>(
      `SELECT height::text AS height, tx_hash, from_addr, to_addr, amount::text AS amount
         FROM gno_grc20_transfer
        WHERE chain_id = $1 AND token = $2
        ORDER BY gno_grc20_transfer.height DESC, tx_hash DESC, event_index DESC
        LIMIT $3`,
      [chain.chainId, key, limit]
    );
    return rows.map((r) => ({
      txHash: r.tx_hash,
      height: Number(r.height),
      from: r.from_addr,
      to: r.to_addr,
      amount: big(r.amount),
    }));
  } catch {
    return null;
  }
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
