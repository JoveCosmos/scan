import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { isBech32ish } from "@/lib/input";
import { accountTxsFromIndexer } from "@/lib/indexer-db";
import { parseAuthAccount, resolveAddressKind, type AddressKind } from "@/lib/address-kind";
import { sumUnits } from "@/lib/format";
import { decodePartyCursor, encodePartyCursor, partyHistory } from "@/lib/indexer-tx";
import {
  rawTxToSummary,
  indexedTxToSummary,
  partyTxToSummary,
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
  /** True when the balance read failed, so an empty list means nothing. */
  balancesFailed?: boolean;
  /** Total on its way out of unbonding, in base denom; null when unread. */
  unbondingTotal?: string | null;
  /** Claimable staking rewards across all validators, every denom. */
  rewards?: Coin[] | null;
  /** Module, escrow, contract, vesting - or a plain account. */
  kind?: AddressKind | null;
}

interface BalancesResponse {
  balances?: Coin[];
  pagination?: { next_key?: string | null };
}
interface DelegationsResponse {
  delegation_responses?: { balance: Coin }[];
  pagination?: { total?: string };
}
interface UnbondingResponse {
  unbonding_responses?: { entries?: { balance?: string }[] }[];
}
interface RewardsResponse {
  total?: Coin[];
}
interface AuthAccountResponse {
  account?: unknown;
}

/** Fraction dropped: rewards below one base unit cannot be withdrawn. */
function wholeUnits(value: string | undefined): string {
  if (!value) return "0";
  const whole = value.split(".")[0];
  return /^\d+$/.test(whole) ? whole : "0";
}

/**
 * Every balance, paging through the bank module. A single page of 100 sorted
 * by denom let the native token fall off the end for accounts holding many
 * IBC tokens - an escrow showed "0 ATOM" beside "Balances (100)".
 */
async function readBalances(chain: ChainConfig, address: string): Promise<Coin[]> {
  const out: Coin[] = [];
  let key: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res: BalancesResponse = await fetchLcd<BalancesResponse>(
      chain,
      `/cosmos/bank/v1beta1/balances/${address}`,
      {
        cache: "no-store",
        timeoutMs: 8000,
        deadlineMs: 12_000,
        searchParams: { "pagination.limit": 200, ...(key ? { "pagination.key": key } : {}) },
      }
    );
    out.push(...(res.balances ?? []));
    key = res.pagination?.next_key ?? null;
    if (!key) break;
  }
  return out;
}

/**
 * Balances, stake, rewards and the auth record for a Cosmos address. Each read
 * is independent, so a disabled or slow module degrades to N/A for its own
 * figure rather than failing the page.
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

  const opts = { cache: "no-store" as const, timeoutMs: 8000, deadlineMs: 12_000 };
  const [balances, delegations, unbonding, rewards, auth] = await Promise.allSettled([
    readBalances(chain, address),
    fetchLcd<DelegationsResponse>(chain, `/cosmos/staking/v1beta1/delegations/${address}`, {
      ...opts,
      searchParams: { "pagination.count_total": true, "pagination.limit": 200 },
    }),
    fetchLcd<UnbondingResponse>(
      chain,
      `/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`,
      { ...opts, searchParams: { "pagination.limit": 100 } }
    ),
    fetchLcd<RewardsResponse>(
      chain,
      `/cosmos/distribution/v1beta1/delegators/${address}/rewards`,
      opts
    ),
    fetchLcd<AuthAccountResponse>(chain, `/cosmos/auth/v1beta1/accounts/${address}`, opts),
  ]);

  const coins = balances.status === "fulfilled" ? balances.value : [];

  let delegatedTotal: string | null = null;
  let delegationCount: number | null = null;
  if (delegations.status === "fulfilled") {
    const rows = delegations.value.delegation_responses ?? [];
    delegationCount = Number(delegations.value.pagination?.total ?? rows.length);
    delegatedTotal = sumUnits(rows.map((d) => d.balance?.amount));
  }

  const unbondingTotal =
    unbonding.status === "fulfilled"
      ? sumUnits(
          (unbonding.value.unbonding_responses ?? []).flatMap((u) =>
            (u.entries ?? []).map((e) => e.balance)
          )
        )
      : null;

  const rewardCoins =
    rewards.status === "fulfilled"
      ? (rewards.value.total ?? [])
          .map((c) => ({ denom: c.denom, amount: wholeUnits(c.amount) }))
          .filter((c) => c.amount !== "0")
      : null;

  const authFacts =
    auth.status === "fulfilled" && auth.value.account ? parseAuthAccount(auth.value.account) : null;
  const kind = await resolveAddressKind(chain, address, authFacts).catch(() => null);

  return {
    address,
    balances: coins,
    balancesFailed: balances.status === "rejected",
    delegatedTotal,
    delegationCount,
    unbondingTotal,
    rewards: rewardCoins,
    accountNumber: authFacts?.accountNumber ?? null,
    sequence: authFacts?.sequence ?? null,
    kind,
    exists:
      coins.length > 0 ||
      (delegationCount ?? 0) > 0 ||
      (unbondingTotal !== null && unbondingTotal !== "0") ||
      !!authFacts ||
      (kind !== null && kind.kind !== "user"),
  };
}

export interface AccountTxs {
  txs: TxSummary[];
  /**
   * Lower bound on the address's transaction count, where the source reports
   * one. Two searches are merged, so their totals overlap and only the larger
   * is certain.
   */
  total: number | null;
  failed: boolean;
  /** "indexer" is our own index; "search" is whatever the node's index holds. */
  source: "search" | "indexer";
  /** Start of the indexed window, when source is "indexer". */
  since?: string;
  /** True when that window is the whole chain. */
  fromGenesis?: boolean;
  /** True when more transactions exist below the page returned. */
  more?: boolean;
  /** Cursor for the next (older) page, or null when this is the last. */
  next?: string | null;
  /** True when one of several searches gave up, so rows may be missing. */
  partial?: boolean;
}

export interface AccountTxsOptions {
  limit?: number;
  /**
   * "i4:<height>:<hash>" for the index's tx_party walk, "i:<height>:<hash>" for
   * the older signer-and-transfer union below it, "p:<page>" for tx search.
   */
  cursor?: string | null;
  /** Decides which searches can find this address's transactions. */
  kind?: AddressKind["kind"];
}

/**
 * Which tx searches find an address's transactions. A module account never
 * signs, and "message.sender" on the distribution module is a search every
 * node gives up on after 30 s; a contract is found by its own address in the
 * wasm events.
 */
export function searchQueries(address: string, kind?: AddressKind["kind"]): string[] {
  if (kind === "module" || kind === "escrow") {
    return [`transfer.recipient='${address}'`, `transfer.sender='${address}'`];
  }
  if (kind === "contract") {
    return [
      `wasm._contract_address='${address}'`,
      `transfer.recipient='${address}'`,
      `transfer.sender='${address}'`,
    ];
  }
  return [`message.sender='${address}'`, `transfer.recipient='${address}'`];
}

/**
 * Transactions an address sent or received, newest first, one page at a time.
 *
 * Indexed first where we have it. Otherwise one tx search per way the address
 * can appear, merged and de-duplicated, since a self-transfer hits two.
 */
export async function getCosmosAccountTxs(
  chain: ChainConfig,
  address: string,
  options: AccountTxsOptions = {}
): Promise<AccountTxs> {
  const limit = options.limit ?? 50;
  // A malformed address cannot have transactions; skip the searches entirely.
  if (!isBech32ish(address)) {
    return { txs: [], total: 0, failed: false, source: "search", next: null };
  }

  const cursor = options.cursor ?? null;
  const partyCursor = decodePartyCursor(cursor);
  // "~" sorts after every hex digit: "below this height, nothing at it".
  const indexedCursor = cursor?.match(/^i:(\d+):([0-9A-Fa-f]+|~)$/);
  const pageCursor = cursor?.match(/^p:(\d+)$/);

  // Every transaction the address touched, in any role, failed ones too -
  // where the index's tx_party covers. Below its floor the older union takes
  // over, on the same page when this one runs short, so paging never notices
  // the seam.
  if (!pageCursor && !indexedCursor) {
    const party = await partyHistory(chain.chainId, address, limit, partyCursor).catch(
      () => null
    );
    if (party && (party.txs.length > 0 || partyCursor || party.floor <= 1)) {
      const txs = party.txs.map((t) => partyTxToSummary(t, address));
      let more = party.more;
      let next: string | null = null;
      const last = party.txs[party.txs.length - 1];
      if (party.more && last) {
        next = encodePartyCursor({ height: last.height, hash: last.hash });
      } else if (party.floor > 1 && txs.length >= limit) {
        // The page filled exactly at the floor: the next one starts below it.
        next = `i:${party.floor}:~`;
        more = true;
      } else if (party.floor > 1) {
        const below = await accountTxsFromIndexer(chain.chainId, address, limit - txs.length, {
          height: String(party.floor),
          hash: "~",
        }).catch(() => null);
        if (below) {
          txs.push(...below.txs.map(indexedTxToSummary));
          const tail = below.txs[below.txs.length - 1];
          more = below.more;
          next = below.more && tail ? `i:${tail.height}:${tail.hash}` : null;
        }
      }
      return {
        txs,
        total: null,
        failed: false,
        source: "indexer",
        since: undefined,
        fromGenesis: party.floor <= 1,
        more,
        next,
      };
    }
  }

  // Our index first: tx search answers only as well as whichever node is asked,
  // and a load-balanced public endpoint can report 2 on one request and 14 on
  // the next for the same address.
  if (!pageCursor) {
    const indexed = await accountTxsFromIndexer(
      chain.chainId,
      address,
      limit,
      indexedCursor ? { height: indexedCursor[1], hash: indexedCursor[2] } : undefined
    ).catch(() => null);
    if (indexed && (indexed.txs.length > 0 || indexedCursor)) {
      const last = indexed.txs[indexed.txs.length - 1];
      return {
        txs: indexed.txs.map(indexedTxToSummary),
        total: null,
        failed: false,
        source: "indexer",
        since: indexed.since,
        fromGenesis: indexed.fromGenesis,
        more: indexed.more,
        next: indexed.more && last ? `i:${last.height}:${last.hash}` : null,
      };
    }
  }

  const page = pageCursor ? Math.max(1, Number(pageCursor[1])) : 1;
  const queries = searchQueries(address, options.kind);

  const results = await Promise.allSettled(
    queries.map((query) =>
      fetchLcd<{ tx_responses?: RawTxResponse[]; total?: string }>(
        chain,
        "/cosmos/tx/v1beta1/txs",
        {
          cache: "no-store",
          // Busy accounts time out on one direction or the other - the
          // distribution module on sender, an escrow on recipient - after the
          // node's own 30 s. A tight budget keeps whichever answers.
          timeoutMs: 8000,
          deadlineMs: 9000,
          searchParams: {
            query,
            order_by: "ORDER_BY_DESC",
            // `limit` and `page` are the current parameters; the pagination
            // form is kept for nodes that still read only that.
            limit,
            page,
            "pagination.limit": limit,
          },
        }
      )
    )
  );

  if (results.every((r) => r.status === "rejected")) {
    return { txs: [], total: null, failed: true, source: "search", next: null };
  }

  const seen = new Set<string>();
  const txs: TxSummary[] = [];
  let total = 0;
  let more = false;

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const reported = Number(result.value.total) || 0;
    total = Math.max(total, reported);
    if (reported > page * limit) more = true;
    for (const raw of result.value.tx_responses ?? []) {
      if (seen.has(raw.txhash)) continue;
      seen.add(raw.txhash);
      txs.push(rawTxToSummary(raw));
    }
  }

  // Merged from independently ordered lists, so re-sort by height.
  txs.sort((a, b) => Number(b.height) - Number(a.height));

  return {
    txs,
    total: total || null,
    failed: false,
    source: "search",
    more,
    next: more ? `p:${page + 1}` : null,
    partial: results.some((r) => r.status === "rejected"),
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
