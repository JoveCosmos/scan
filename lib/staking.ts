import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";
import { isBech32ish } from "@/lib/input";
import { getValidatorsCached, getInactiveValidators } from "@/lib/validators";
import { accountFromOperator } from "@/lib/bech32";
import type { Coin } from "@/lib/accounts";

/** Where a validator stands, for an account's view of its own stake. */
export type ValidatorState = "active" | "unbonding" | "inactive" | "jailed" | null;

export interface DelegationRow {
  validator: string;
  /** Null when the validator is in neither set we read. */
  moniker: string | null;
  jailed: boolean;
  state: ValidatorState;
  /** Bonded amount, in the chain's base denom. */
  amount: string;
  /** Outstanding reward in the base denom, or null when the query failed. */
  reward: string | null;
}

export interface UnbondingRow {
  validator: string;
  moniker: string | null;
  state: ValidatorState;
  amount: string;
  /** ISO timestamp the tokens become liquid. */
  completion: string;
}

export interface RedelegationRow {
  from: string;
  to: string;
  fromMoniker: string | null;
  toMoniker: string | null;
  fromState: ValidatorState;
  toState: ValidatorState;
  amount: string;
  completion: string;
}

export interface AccountStaking {
  delegations: DelegationRow[];
  unbonding: UnbondingRow[];
  redelegations: RedelegationRow[];
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
}

/**
 * Rewards come back as decimal strings - "16021146.828901032017806464" - because
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

/**
 * Everything an account has at stake: what is bonded and to whom, what is on its
 * way back out, and what is mid-flight between validators.
 *
 * Four independent reads. Each is allowed to fail on its own - a chain with the
 * distribution module disabled still shows delegations, just without rewards -
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
    failed: false,
  };

  // Addresses are interpolated into LCD paths. See lib/input.ts.
  if (!isBech32ish(address)) return empty;

  const [delegations, unbonding, redelegations, rewards, active, inactive] =
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
      // Both sets, cached: a delegation to a jailed or inactive validator is
      // still a delegation to someone with a name, and the bonded set alone
      // showed it as a truncated address marked "bonded".
      getValidatorsCached(chain),
      getInactiveValidators(chain),
    ]);

  if (delegations.status === "rejected") return { ...empty, failed: true };

  const monikers = new Map<string, { moniker: string; jailed: boolean; state: ValidatorState }>();
  for (const set of [active, inactive]) {
    if (set.status !== "fulfilled") continue;
    for (const v of set.value) {
      monikers.set(v.operatorAddress, {
        moniker: v.moniker,
        jailed: v.jailed,
        state: v.jailed
          ? "jailed"
          : v.status === "BOND_STATUS_BONDED"
            ? "active"
            : v.status === "BOND_STATUS_UNBONDING"
              ? "unbonding"
              : "inactive",
      });
    }
  }

  // Reward per validator, in the staking denom only. Cosmos Hub also pays a
  // dozen IBC denoms whose dust would crowd out the figure a delegator came for;
  // a chain that genuinely rewarded in several would need a coin list per row.
  const rewardByValidator = new Map<string, string>();
  if (rewards.status === "fulfilled") {
    for (const r of rewards.value.rewards ?? []) {
      const own = r.reward?.find((c) => c.denom === chain.denom);
      if (r.validator_address) {
        rewardByValidator.set(r.validator_address, truncateDecimal(own?.amount));
      }
    }
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
          state: known?.state ?? null,
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
                    state: monikers.get(u.validator_address)?.state ?? null,
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
                    fromState: monikers.get(from)?.state ?? null,
                    toState: monikers.get(to)?.state ?? null,
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
    failed: false,
  };
}

export interface SelfBond {
  /** Base denom. */
  amount: string;
  /** Share of the validator's total stake, 0–1. Null if total is unknown. */
  share: number | null;
}

interface SingleDelegationResponse {
  delegation_response?: { balance?: Coin };
}

/**
 * What a validator has staked on itself.
 *
 * The number a delegator actually wants: an operator with little of its own
 * stake at risk is exposed to less of the loss it would cause. The staking
 * module does not carry it on the validator record - it is an ordinary
 * delegation from the operator's own account, so it has to be asked for
 * separately.
 *
 * Null rather than zero when the query fails: "no self bond" is a strong claim
 * and a failed read is not evidence for it.
 */
export async function getSelfBond(
  chain: ChainConfig,
  operatorAddress: string,
  totalTokens: string | null
): Promise<SelfBond | null> {
  const account = accountFromOperator(operatorAddress, chain.bech32Prefix);
  if (!account || !isBech32ish(account)) return null;

  try {
    const res = await fetchLcd<SingleDelegationResponse>(
      chain,
      `/cosmos/staking/v1beta1/validators/${operatorAddress}/delegations/${account}`,
      { cache: "no-store", timeoutMs: 10_000 }
    );
    const amount = res.delegation_response?.balance?.amount;
    if (!amount) return null;

    let share: number | null = null;
    if (totalTokens && /^\d+$/.test(totalTokens) && BigInt(totalTokens) > BigInt(0)) {
      share = Number(amount) / Number(totalTokens);
      if (!Number.isFinite(share)) share = null;
    }
    return { amount, share };
  } catch {
    // A validator with no self delegation 404s here, which is a real answer -
    // but so does an endpoint having a bad day, and the two are not
    // distinguishable from the status alone.
    return null;
  }
}

/**
 * Self bond for a whole validator set, keyed by operator address.
 *
 * There is no bulk endpoint for this - a self bond is an ordinary delegation,
 * so it is one query per validator. That is the whole design problem here: 100
 * validators is 100 requests against endpoints we do not run.
 *
 * Hence a long cache and a small concurrency window. Self bond moves when an
 * operator bonds or unbonds its own stake, which is rare - a ten minute answer
 * is not meaningfully staler than a live one, and it turns 100 requests per page
 * view into 100 per ten minutes. Failures are omitted rather than cached as
 * zero: the column shows "-" and tries again next window.
 */
export async function getSelfBonds(
  chain: ChainConfig,
  validators: { operatorAddress: string; tokens: string }[]
): Promise<Map<string, SelfBond>> {
  // Stale-while-revalidate for an hour: the read is one request per validator
  // (~3s on a 100-validator set), and nobody should wait on it after the first.
  return cached(`selfbond:${chain.chainId}`, 600_000, loadSelfBonds, {
    staleMs: 3_600_000,
  });

  async function loadSelfBonds(): Promise<Map<string, SelfBond>> {
    const out = new Map<string, SelfBond>();
    const queue = [...validators];
    const CONCURRENCY = 10;

    async function worker() {
      for (;;) {
        const v = queue.shift();
        if (!v) return;
        const bond = await getSelfBond(chain, v.operatorAddress, v.tokens).catch(
          () => null
        );
        if (bond) out.set(v.operatorAddress, bond);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return out;
  }
}
