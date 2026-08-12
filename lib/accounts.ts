import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { isBech32ish } from "@/lib/input";
import { accountTxsFromIndexer, type IndexedAccountTx } from "@/lib/indexer-db";
import {
  rawTxToSummary,
  labelForType,
  type RawTxResponse,
  type TxSummary,
} from "@/lib/txs";

export interface Coin {
  denom: string;
  amount: string;
}

export interface AccountView {
  address: string;
  balances: Coin[];
  /** Total bonded to validators, in base denom. Cosmos only. */
  delegatedTotal: string | null;
  delegationCount: number | null;
  accountNumber: string | null;
  sequence: string | null;
  /** False when the chain has no record of the address at all. */
  exists: boolean;
}

interface BalancesResponse {
  balances?: Coin[];
}
interface DelegationsResponse {
  delegation_responses?: { balance: Coin }[];
  pagination?: { total?: string };
}
interface AuthAccountResponse {
  account?: { account_number?: string; sequence?: string };
}

/**
 * Balances, delegations and the auth record for a Cosmos address. Each read is
 * independent so a disabled or slow module degrades to "—" rather than failing.
 */
export async function getCosmosAccount(
  chain: ChainConfig,
  address: string
): Promise<AccountView> {
  // Addresses are interpolated into LCD paths. See lib/input.ts.
  if (!isBech32ish(address)) {
    return {
      address,
      balances: [],
      delegatedTotal: null,
      delegationCount: null,
      accountNumber: null,
      sequence: null,
      exists: false,
    };
  }

  const [balances, delegations, auth] = await Promise.allSettled([
    fetchLcd<BalancesResponse>(
      chain,
      `/cosmos/bank/v1beta1/balances/${address}`,
      { cache: "no-store", timeoutMs: 10_000, searchParams: { "pagination.limit": 100 } }
    ),
    fetchLcd<DelegationsResponse>(
      chain,
      `/cosmos/staking/v1beta1/delegations/${address}`,
      {
        cache: "no-store",
        timeoutMs: 12_000,
        searchParams: { "pagination.count_total": true, "pagination.limit": 200 },
      }
    ),
    fetchLcd<AuthAccountResponse>(chain, `/cosmos/auth/v1beta1/accounts/${address}`, {
      cache: "no-store",
      timeoutMs: 10_000,
    }),
  ]);

  const coins = balances.status === "fulfilled" ? (balances.value.balances ?? []) : [];

  let delegatedTotal: string | null = null;
  let delegationCount: number | null = null;
  if (delegations.status === "fulfilled") {
    const rows = delegations.value.delegation_responses ?? [];
    delegationCount = Number(delegations.value.pagination?.total ?? rows.length);
    const total = rows.reduce((sum, d) => sum + Number(d.balance?.amount ?? 0), 0);
    delegatedTotal = Number.isFinite(total) ? String(total) : null;
  }

  return {
    address,
    balances: coins,
    delegatedTotal,
    delegationCount,
    accountNumber:
      auth.status === "fulfilled" ? (auth.value.account?.account_number ?? null) : null,
    sequence: auth.status === "fulfilled" ? (auth.value.account?.sequence ?? null) : null,
    exists:
      coins.length > 0 ||
      (delegationCount ?? 0) > 0 ||
      (auth.status === "fulfilled" && !!auth.value.account),
  };
}

export interface AccountTxs {
  txs: TxSummary[];
  total: number | null;
  failed: boolean;
  /**
   * Where the list came from. "indexer" is bounded by what we have indexed, so
   * the page says so; "search" is whatever the node's tx index still holds,
   * which is its own kind of incomplete.
   */
  source: "search" | "indexer";
  /** Start of the indexed window, when source is "indexer". */
  since?: string;
  /** True when more transactions exist below the page returned. */
  more?: boolean;
}

/**
 * Transactions an address sent or received.
 *
 * Indexed first where we have it. Otherwise two tx searches, because the node
 * indexes them differently: `message.sender` catches what the address signed,
 * `transfer.recipient` catches what was sent to it. Those are merged and
 * de-duplicated, since a self-transfer hits both.
 */
export async function getCosmosAccountTxs(
  chain: ChainConfig,
  address: string,
  limit = 50
): Promise<AccountTxs> {
  // A malformed address cannot have transactions; skip the searches entirely.
  if (!isBech32ish(address)) {
    return { txs: [], total: 0, failed: false, source: "search" };
  }

  // Tried first, because tx search answers only as well as whichever node is
  // asked. On AtomOne one public endpoint refuses outright ("transaction
  // indexing is disabled") and the other returns a total of 1 for an address
  // that transacted minutes earlier — its index reaches back only as far as the
  // snapshot it resynced from. Neither is wrong to do; both mean the history a
  // reader sees depends on a third party's pruning. Ours does not.
  const indexed = await accountTxsFromIndexer(chain.chainId, address, limit).catch(
    () => null
  );
  if (indexed && indexed.txs.length > 0) {
    return {
      txs: indexed.txs.map(toSummaryFromIndex),
      total: indexed.txs.length,
      failed: false,
      source: "indexer",
      since: indexed.since,
      more: indexed.more,
    };
  }

  const queries = [
    `message.sender='${address}'`,
    `transfer.recipient='${address}'`,
  ];

  const results = await Promise.allSettled(
    queries.map((query) =>
      fetchLcd<{ tx_responses?: RawTxResponse[]; total?: string }>(
        chain,
        "/cosmos/tx/v1beta1/txs",
        {
          cache: "no-store",
          timeoutMs: 15_000,
          searchParams: {
            query,
            order_by: "ORDER_BY_DESC",
            "pagination.limit": limit,
          },
        }
      )
    )
  );

  if (results.every((r) => r.status === "rejected")) {
    return { txs: [], total: null, failed: true, source: "search" };
  }

  const seen = new Set<string>();
  const txs: TxSummary[] = [];
  let total = 0;

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    total += Number(result.value.total) || 0;
    for (const raw of result.value.tx_responses ?? []) {
      if (seen.has(raw.txhash)) continue;
      seen.add(raw.txhash);
      txs.push(rawTxToSummary(raw));
    }
  }

  // Merged from two independently ordered lists, so re-sort by height.
  txs.sort((a, b) => Number(b.height) - Number(a.height));

  return {
    txs: txs.slice(0, limit),
    total: total || txs.length,
    failed: false,
    source: "search",
  };
}

/**
 * An indexed row in the shape the list view already renders.
 *
 * The index stores extracted facts rather than transaction bodies, so a few
 * fields a raw tx would carry are simply absent: gas is not kept, and memos
 * are not either. Null says so rather than implying zero.
 */
function toSummaryFromIndex(t: IndexedAccountTx): TxSummary {
  return {
    hash: t.hash,
    height: t.height,
    time: t.time,
    code: t.code,
    messages: t.msgTypes.map((typeUrl) => ({
      typeUrl,
      label: labelForType(typeUrl),
      // Per-message parties are not indexed; the tx-level transfer below
      // carries the movement this account was party to.
      transfer: null,
    })),
    messageCount: t.msgTypes.length,
    transfer: t.transfer
      ? {
          from: t.transfer.from,
          to: t.transfer.to,
          amount: [{ denom: t.transfer.denom, amount: t.transfer.amount }],
          // Bank transfers between accounts; staking movements are their own
          // event kinds and are not matched here.
          staking: false,
        }
      : null,
    fee:
      t.feeDenom && t.feeAmount
        ? [{ denom: t.feeDenom, amount: t.feeAmount }]
        : [],
    gasUsed: null,
    gasWanted: null,
    memo: "",
  };
}

/** "999999997125000000ugnot" -> { amount, denom }. */
export function parseCoinString(value: string): Coin[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const m = part.match(/^(\d+)\s*([a-zA-Z/][\w/.-]*)$/);
      return m ? [{ amount: m[1], denom: m[2] }] : [];
    });
}
