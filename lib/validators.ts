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
