import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

interface RawValidator {
  operator_address: string;
  consensus_pubkey?: { key?: string };
  jailed: boolean;
  status: string;
  tokens: string;
  description: {
    moniker: string;
    identity: string;
    website: string;
    details: string;
  };
  commission: {
    commission_rates: { rate: string; max_rate: string; max_change_rate: string };
  };
}

interface ValidatorsResponse {
  validators: RawValidator[];
  pagination: { next_key: string | null; total: string };
}

export interface ValidatorSummary {
  rank: number;
  operatorAddress: string;
  moniker: string;
  website: string;
  jailed: boolean;
  status: string;
  tokens: string;
  /** Base64 ed25519 key; uptime derives the consensus address from it. */
  consensusPubkey: string | null;
  /** Share of total bonded stake, 0–1. */
  votingPower: number;
  /** Running total of votingPower down the ranked list, 0–1. */
  cumulativePower: number;
  commissionRate: number;
}

const STATUS_LABEL: Record<string, string> = {
  BOND_STATUS_BONDED: "Active",
  BOND_STATUS_UNBONDING: "Unbonding",
  BOND_STATUS_UNBONDED: "Inactive",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export interface ValidatorDetail {
  operatorAddress: string;
  /** Base64 ed25519 key, so uptime can be resolved for this one validator. */
  consensusPubkey: string | null;
  moniker: string;
  identity: string;
  website: string;
  details: string;
  securityContact: string;
  jailed: boolean;
  status: string;
  tokens: string;
  commissionRate: number;
  maxRate: number;
  maxChangeRate: number;
  commissionUpdatedAt: string | null;
  minSelfDelegation: string;
  unbondingHeight: string | null;
  unbondingTime: string | null;
  /** Share of total bonded stake, 0–1. null when the set could not be read. */
  votingPower: number | null;
  rank: number | null;
  outstandingCommission: { denom: string; amount: string }[];
}

interface SingleValidatorResponse {
  validator: RawValidator & {
    description: RawValidator["description"] & { security_contact?: string };
    commission: RawValidator["commission"] & { update_time?: string };
    min_self_delegation?: string;
    unbonding_height?: string;
    unbonding_time?: string;
  };
}

interface CommissionResponse {
  commission?: { commission?: { denom: string; amount: string }[] };
}

/**
 * Full profile for one validator. Rank and voting power need the whole bonded
 * set, and the delegator count and outstanding commission come from separate
 * modules — each is optional so a slow or disabled endpoint degrades to "—"
 * instead of failing the page.
 */
export async function getValidator(
  chain: ChainConfig,
  operatorAddress: string
): Promise<ValidatorDetail | null> {
  let single: SingleValidatorResponse;
  try {
    single = await fetchLcd<SingleValidatorResponse>(
      chain,
      `/cosmos/staking/v1beta1/validators/${operatorAddress}`,
      { cache: "no-store", timeoutMs: 10_000 }
    );
  } catch {
    return null;
  }

  const v = single.validator;
  if (!v) return null;

  const [setResult, commissionResult] = await Promise.allSettled([
    getValidators(chain),
    fetchLcd<CommissionResponse>(
      chain,
      `/cosmos/distribution/v1beta1/validators/${operatorAddress}/commission`,
      { cache: "no-store", timeoutMs: 10_000 }
    ),
  ]);

  let votingPower: number | null = null;
  let rank: number | null = null;
  if (setResult.status === "fulfilled") {
    const hit = setResult.value.find((x) => x.operatorAddress === operatorAddress);
    if (hit) {
      votingPower = hit.votingPower;
      rank = hit.rank;
    }
  }

  return {
    operatorAddress: v.operator_address,
    consensusPubkey: v.consensus_pubkey?.key ?? null,
    moniker: v.description?.moniker?.trim() || v.operator_address,
    identity: v.description?.identity ?? "",
    website: v.description?.website ?? "",
    details: v.description?.details ?? "",
    securityContact: v.description?.security_contact ?? "",
    jailed: v.jailed,
    status: v.status,
    tokens: v.tokens,
    commissionRate: Number(v.commission?.commission_rates?.rate ?? 0),
    maxRate: Number(v.commission?.commission_rates?.max_rate ?? 0),
    maxChangeRate: Number(v.commission?.commission_rates?.max_change_rate ?? 0),
    commissionUpdatedAt: v.commission?.update_time ?? null,
    minSelfDelegation: v.min_self_delegation ?? "0",
    unbondingHeight:
      v.unbonding_height && v.unbonding_height !== "0" ? v.unbonding_height : null,
    unbondingTime: v.unbonding_time ?? null,
    votingPower,
    rank,
    outstandingCommission:
      commissionResult.status === "fulfilled"
        ? (commissionResult.value.commission?.commission ?? [])
        : [],
  };
}

export interface Delegator {
  address: string;
  /** Bonded amount in base denom. */
  amount: string;
  /** Share of this validator's stake, 0–1. */
  share: number;
}

interface DelegationRow {
  delegation?: { delegator_address?: string };
  balance?: { amount?: string };
}

/**
 * Who delegates to this validator, largest first.
 *
 * One page only: some validators have tens of thousands of delegators and the
 * long tail is dust. The total count comes from the same response, so the page
 * can say how many are not shown.
 */
export async function getValidatorDelegators(
  chain: ChainConfig,
  operatorAddress: string,
  limit = 25
): Promise<{ delegators: Delegator[]; total: number | null; failed: boolean }> {
  try {
    const res = await fetchLcd<{
      delegation_responses?: DelegationRow[];
      pagination?: { total?: string };
    }>(chain, `/cosmos/staking/v1beta1/validators/${operatorAddress}/delegations`, {
      cache: "no-store",
      timeoutMs: 15_000,
      searchParams: {
        // No count_total: measured at ~6.4s with it versus ~2.2s without, because
        // counting every delegation is a full scan. The exact total is not worth
        // four seconds on a "largest delegators" list.
        "pagination.limit": 200,
      },
    });

    const rows = res.delegation_responses ?? [];
    const totalStake = rows.reduce((sum, r) => sum + Number(r.balance?.amount ?? 0), 0);

    const delegators: Delegator[] = rows
      .map((r) => ({
        address: r.delegation?.delegator_address ?? "",
        amount: r.balance?.amount ?? "0",
        share: totalStake > 0 ? Number(r.balance?.amount ?? 0) / totalStake : 0,
      }))
      .filter((d) => d.address)
      .sort((a, b) => Number(b.amount) - Number(a.amount));

    return {
      delegators: delegators.slice(0, limit),
      // Null unless the endpoint volunteered a count; we no longer ask for one.
      total: res.pagination?.total ? Number(res.pagination.total) : null,
      failed: false,
    };
  } catch {
    return { delegators: [], total: null, failed: true };
  }
}

/**
 * Bonded validator set, ranked by stake. Pages through the LCD because several
 * chains cap page size well below their validator count.
 */
export async function getValidators(chain: ChainConfig): Promise<ValidatorSummary[]> {
  const collected: RawValidator[] = [];
  let nextKey: string | null = null;

  for (let page = 0; page < 10; page++) {
    const res: ValidatorsResponse = await fetchLcd<ValidatorsResponse>(
      chain,
      "/cosmos/staking/v1beta1/validators",
      {
        cache: "no-store",
        timeoutMs: 10_000,
        searchParams: {
          status: "BOND_STATUS_BONDED",
          "pagination.limit": 200,
          ...(nextKey ? { "pagination.key": nextKey } : {}),
        },
      }
    );

    collected.push(...res.validators);
    nextKey = res.pagination?.next_key ?? null;
    if (!nextKey) break;
  }

  const ranked = collected
    .slice()
    .sort((a, b) => Number(b.tokens) - Number(a.tokens));

  const totalBonded = ranked.reduce((sum, v) => sum + Number(v.tokens), 0);

  let running = 0;
  return ranked.map((v, i) => {
    const power = totalBonded > 0 ? Number(v.tokens) / totalBonded : 0;
    running += power;
    return {
      rank: i + 1,
      operatorAddress: v.operator_address,
      moniker: v.description?.moniker?.trim() || v.operator_address,
      website: v.description?.website ?? "",
      jailed: v.jailed,
      status: v.status,
      tokens: v.tokens,
      consensusPubkey: v.consensus_pubkey?.key ?? null,
      votingPower: power,
      cumulativePower: running,
      commissionRate: Number(v.commission?.commission_rates?.rate ?? 0),
    };
  });
}
