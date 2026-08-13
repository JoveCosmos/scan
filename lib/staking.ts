import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { isBech32ish } from "@/lib/input";
import { getValidators } from "@/lib/validators";
import type { Coin } from "@/lib/accounts";

export interface DelegationRow {
  validator: string;
  /** Null when the validator is not in the current set — see monikerMap. */
  moniker: string | null;
  jailed: boolean;
  /** Bonded amount, in the chain's base denom. */
  amount: string;
  /** Outstanding reward in the base denom, or null when the query failed. */
  reward: string | null;
}

export interface UnbondingRow {
  validator: string;
  moniker: string | null;
  amount: string;
  /** ISO timestamp the tokens become liquid. */
  completion: string;
}

export interface RedelegationRow {
  from: string;
  to: string;
  fromMoniker: string | null;
  toMoniker: string | null;
  amount: string;
  completion: string;
}

export interface AccountStaking {
  delegations: DelegationRow[];
  unbonding: UnbondingRow[];
  redelegations: RedelegationRow[];
  /** Sum of `amount` across delegations, base denom. */
  bondedTotal: string;
  /** Sum of outstanding rewards, base denom. Null when the module did not answer. */
  rewardTotal: string | null;
  /** True when the delegations query itself failed, as opposed to being empty. */
  failed: boolean;
}

interface DelegationsResponse {
  delegation_responses?: {
    delegation?: { validator_address?: string };
    balance?: Coin;
  }[];
}

interface UnbondingResponse {
  unbonding_responses?: {
    validator_address?: string;
    entries?: { balance?: string; completion_time?: string }[];
  }[];
}

interface RedelegationsResponse {
  redelegation_responses?: {
    redelegation?: {
      validator_src_address?: string;
      validator_dst_address?: string;
    };
    entries?: {
      redelegation_entry?: { completion_time?: string };
      balance?: string;
    }[];
  }[];
}

interface RewardsResponse {
  rewards?: { validator_address?: string; reward?: Coin[] }[];
  total?: Coin[];
}

/**
 * Rewards come back as decimal strings — "16021146.828901032017806464" — because
 * the distribution module tracks fractions of a token. Everything downstream
 * treats amounts as integer base units, so the fraction is dropped rather than
 * rounded: a reward is not claimable below one base unit anyway, and rounding up
 * would show a balance that cannot be withdrawn.
 *
 * Exported for tests; the decimals here exceed what Number can hold, so parsing
 * with Number() would lose precision before the truncation ever happened.
 */
export function truncateDecimal(value: string | undefined): string {
  if (!value) return "0";
  const dot = value.indexOf(".");
  const whole = dot === -1 ? value : value.slice(0, dot);
  return /^\d+$/.test(whole) ? whole : "0";
}

function sum(values: string[]): string {
  return values
    .reduce((total, v) => total + BigInt(/^\d+$/.test(v) ? v : "0"), BigInt(0))
    .toString();
}

/**
 * Everything an account has at stake: what is bonded and to whom, what is on its
 * way back out, and what is mid-flight between validators.
 *
 * Four independent reads. Each is allowed to fail on its own — a chain with the
 * distribution module disabled still shows delegations, just without rewards —
 * because a single missing module should not blank the whole section.
 *
 * Monikers come from the validator set that the validators page has already
 * fetched, so this adds no request in the common case. A delegation to a
 * validator missing from that set (unbonded long enough to fall off) keeps a
 * null moniker and renders as its address rather than inventing a name.
 */
export async function getAccountStaking(
  chain: ChainConfig,
  address: string
): Promise<AccountStaking> {
  const empty: AccountStaking = {
    delegations: [],
    unbonding: [],
    redelegations: [],
    bondedTotal: "0",
    rewardTotal: null,
    failed: false,
  };

  // Addresses are interpolated into LCD paths. See lib/input.ts.
  if (!isBech32ish(address)) return empty;

  const [delegations, unbonding, redelegations, rewards, validators] =
    await Promise.allSettled([
      fetchLcd<DelegationsResponse>(
        chain,
        `/cosmos/staking/v1beta1/delegations/${address}`,
        {
          cache: "no-store",
          timeoutMs: 12_000,
          searchParams: { "pagination.limit": 200 },
        }
      ),
      fetchLcd<UnbondingResponse>(
        chain,
        `/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`,
        { cache: "no-store", timeoutMs: 12_000, searchParams: { "pagination.limit": 100 } }
      ),
      fetchLcd<RedelegationsResponse>(
        chain,
        `/cosmos/staking/v1beta1/delegators/${address}/redelegations`,
        { cache: "no-store", timeoutMs: 12_000, searchParams: { "pagination.limit": 100 } }
      ),
      fetchLcd<RewardsResponse>(
        chain,
        `/cosmos/distribution/v1beta1/delegators/${address}/rewards`,
        { cache: "no-store", timeoutMs: 12_000 }
      ),
      getValidators(chain),
    ]);

  if (delegations.status === "rejected") return { ...empty, failed: true };

  const monikers = new Map<string, { moniker: string; jailed: boolean }>();
  if (validators.status === "fulfilled") {
    for (const v of validators.value) {
      monikers.set(v.operatorAddress, { moniker: v.moniker, jailed: v.jailed });
    }
  }

  // Reward per validator, in the staking denom only. A chain paying rewards in
  // several denoms would need a coin list per row; none here do, and showing the
  // staking denom is what the totals elsewhere on the page mean.
  const rewardByValidator = new Map<string, string>();
  let rewardTotal: string | null = null;
  if (rewards.status === "fulfilled") {
    for (const r of rewards.value.rewards ?? []) {
      const own = r.reward?.find((c) => c.denom === chain.denom);
      if (r.validator_address) {
        rewardByValidator.set(r.validator_address, truncateDecimal(own?.amount));
      }
    }
    const total = rewards.value.total?.find((c) => c.denom === chain.denom);
    rewardTotal = truncateDecimal(total?.amount);
  }

  const rows: DelegationRow[] = (delegations.value.delegation_responses ?? [])
    .flatMap((d) => {
      const validator = d.delegation?.validator_address;
      const amount = d.balance?.amount;
      if (!validator || !amount) return [];
      const known = monikers.get(validator);
      return [
        {
          validator,
          moniker: known?.moniker ?? null,
          jailed: known?.jailed ?? false,
          amount,
          reward: rewards.status === "fulfilled"
            ? (rewardByValidator.get(validator) ?? "0")
            : null,
        },
      ];
    })
    // Largest stake first: the ordering the LCD returns is by validator address,
    // which tells a reader nothing.
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));

  const unbondingRows: UnbondingRow[] =
    unbonding.status === "fulfilled"
      ? (unbonding.value.unbonding_responses ?? []).flatMap((u) =>
          (u.entries ?? []).flatMap((e) =>
            u.validator_address && e.balance && e.completion_time
              ? [
                  {
                    validator: u.validator_address,
                    moniker: monikers.get(u.validator_address)?.moniker ?? null,
                    amount: e.balance,
                    completion: e.completion_time,
                  },
                ]
              : []
          )
        )
      : [];

  const redelegationRows: RedelegationRow[] =
    redelegations.status === "fulfilled"
      ? (redelegations.value.redelegation_responses ?? []).flatMap((r) => {
          const from = r.redelegation?.validator_src_address;
          const to = r.redelegation?.validator_dst_address;
          if (!from || !to) return [];
          return (r.entries ?? []).flatMap((e) =>
            e.balance && e.redelegation_entry?.completion_time
              ? [
                  {
                    from,
                    to,
                    fromMoniker: monikers.get(from)?.moniker ?? null,
                    toMoniker: monikers.get(to)?.moniker ?? null,
                    amount: e.balance,
                    completion: e.redelegation_entry.completion_time,
                  },
                ]
              : []
          );
        })
      : [];

  return {
    delegations: rows,
    unbonding: unbondingRows.sort((a, b) => a.completion.localeCompare(b.completion)),
    redelegations: redelegationRows.sort((a, b) =>
      a.completion.localeCompare(b.completion)
    ),
    bondedTotal: sum(rows.map((r) => r.amount)),
    rewardTotal,
    failed: false,
  };
}
