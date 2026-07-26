import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

interface RawValidator {
  operator_address: string;
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
  delegatorCount: string | null;
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

interface DelegationsResponse {
  pagination?: { total?: string };
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

  const [setResult, delegationsResult, commissionResult] = await Promise.allSettled([
    getValidators(chain),
    fetchLcd<DelegationsResponse>(
      chain,
      `/cosmos/staking/v1beta1/validators/${operatorAddress}/delegations`,
      {
        cache: "no-store",
        timeoutMs: 12_000,
        searchParams: { "pagination.count_total": true, "pagination.limit": 1 },
      }
    ),
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
    delegatorCount:
      delegationsResult.status === "fulfilled"
        ? (delegationsResult.value.pagination?.total ?? null)
        : null,
    outstandingCommission:
      commissionResult.status === "fulfilled"
        ? (commissionResult.value.commission?.commission ?? [])
        : [],
  };
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
      votingPower: power,
      cumulativePower: running,
      commissionRate: Number(v.commission?.commission_rates?.rate ?? 0),
    };
  });
}
