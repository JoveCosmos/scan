import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

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
