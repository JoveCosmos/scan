import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { isBech32ish } from "@/lib/input";
import { cached } from "@/lib/cache";

interface RawValidator {
  operator_address: string;
  consensus_pubkey?: { key?: string };
  jailed: boolean;
  status: string;
  tokens: string;
  delegator_shares?: string;
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
  /** Keybase key suffix the operator published; absent or "" when none. */
  identity?: string;
  jailed: boolean;
  status: string;
  tokens: string;
  /** Shares issued against `tokens`; a share converts to tokens/delegatorShares. */
  delegatorShares?: string;
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
 * modules - each is optional so a slow or disabled endpoint degrades to "-"
 * instead of failing the page.
 */
/**
 * The bonded set, shared by every page that needs it. Fresh for 30s, and served
 * stale for up to five minutes while a refresh runs, so no page view waits on
 * the full-set read after the first.
 */
export function getValidatorsCached(chain: ChainConfig): Promise<ValidatorSummary[]> {
  return cached(`validators:${chain.chainId}`, 30_000, () => getValidators(chain), {
    staleMs: 5 * 60_000,
  });
}

export function getValidator(
  chain: ChainConfig,
  operatorAddress: string
): Promise<ValidatorDetail | null> {
  // Operator addresses are interpolated into LCD paths. See lib/input.ts.
  if (!isBech32ish(operatorAddress)) return Promise.resolve(null);
  // The page and its metadata both ask for the same validator on every view;
  // a short cache makes that one pair of requests rather than two.
  return cached(`validator:${chain.chainId}:${operatorAddress}`, 15_000, () =>
    readValidator(chain, operatorAddress)
  );
}

async function readValidator(
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
    getValidatorsCached(chain),
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

/** Rows per delegations request. Measured on a 4,598-delegator validator:
 *  500 rows 0.54s, 1,000 rows 0.94s, 2,000 rows 1.13s - the per-request
 *  overhead dominates, so ask for large pages and make few requests. */
const DELEGATION_PAGE = 2000;
/** Ceiling of 50,000 delegations. Beyond this the tail is dust and the wait
 *  stops being worth it; the caller is told the ranking is partial. */
const DELEGATION_MAX_PAGES = 25;

/**
 * Who delegates to this validator, largest first.
 *
 * This reads *every* delegation, not one page. The LCD returns delegations in
 * key order, not by size, so ranking a single page ranks an arbitrary subset -
 * GATA HUB has 4,598 delegators, and sorting the first 200 of them silently
 * omitted the largest. Paging the lot costs ~4.7s there, which is why the
 * caller streams this section separately.
 *
 * Reading everything also makes the total exact by construction, with no
 * `count_total` scan.
 */
export interface DelegatorPage {
  delegators: Delegator[];
  /** Rank of the first row, 1-based. */
  offset: number;
  total: number | null;
  /** Share of the validator's stake held by its ten largest delegators, 0–1. */
  top10Share: number | null;
  /** True when the page cap was hit, so the ranking may miss a delegator. */
  truncated: boolean;
  failed: boolean;
}

interface RankedDelegations {
  /** The amount is kept once, as a BigInt; its string form is made per page. */
  rows: { address: string; raw: bigint }[];
  totalStake: bigint;
  truncated: boolean;
}

/** Share of `total` held by `part`, through BigInt so large stakes stay exact. */
function shareOf(part: bigint, total: bigint): number {
  return total > BigInt(0) ? Number((part * BigInt(1_000_000)) / total) / 1_000_000 : 0;
}

/**
 * Who delegates to this validator, largest first, one page at a time.
 *
 * This reads *every* delegation, not one page. The LCD returns delegations in
 * key order, not by size, so ranking a single page ranks an arbitrary subset -
 * GATA HUB has 4,598 delegators, and sorting the first 200 of them silently
 * omitted the largest. Paging the lot costs ~4.7s there, so the ranked list is
 * cached and every page after the first is served from it.
 */
export async function getValidatorDelegators(
  chain: ChainConfig,
  operatorAddress: string,
  page: { offset: number; limit: number } = { offset: 0, limit: 100 }
): Promise<DelegatorPage> {
  const offset = Math.max(0, Math.floor(page.offset));
  const failed: DelegatorPage = {
    delegators: [],
    offset,
    total: null,
    top10Share: null,
    truncated: false,
    failed: true,
  };
  // Same gate as getValidator: the address goes into an LCD path.
  if (!isBech32ish(operatorAddress)) return failed;

  let ranked: RankedDelegations;
  try {
    ranked = await cached(
      `delegations:${chain.chainId}:${operatorAddress}`,
      5 * 60_000,
      () => readDelegations(chain, operatorAddress),
      // A ranking can run to 50,000 rows, and crawlers open every validator:
      // only the most recently read rankings are held, never one per validator.
      { staleMs: 30 * 60_000, group: { name: "delegations", max: 24 } }
    );
  } catch {
    return failed;
  }

  const { rows, totalStake, truncated } = ranked;
  const top10 = rows.slice(0, 10).reduce((sum, d) => sum + d.raw, BigInt(0));

  return {
    delegators: rows.slice(offset, offset + page.limit).map((d) => ({
      address: d.address,
      amount: d.raw.toString(),
      share: shareOf(d.raw, totalStake),
    })),
    offset,
    total: rows.length,
    top10Share: rows.length > 0 ? shareOf(top10, totalStake) : null,
    truncated,
    failed: false,
  };
}

async function readDelegations(
  chain: ChainConfig,
  operatorAddress: string
): Promise<RankedDelegations> {
  const rows: DelegationRow[] = [];
  let nextKey: string | null = null;
  let truncated = true;

  for (let page = 0; page < DELEGATION_MAX_PAGES; page++) {
    const res: {
      delegation_responses?: DelegationRow[];
      pagination?: { next_key?: string | null };
    } = await fetchLcd(chain, `/cosmos/staking/v1beta1/validators/${operatorAddress}/delegations`, {
      cache: "no-store",
      timeoutMs: 20_000,
      searchParams: {
        "pagination.limit": DELEGATION_PAGE,
        ...(nextKey ? { "pagination.key": nextKey } : {}),
      },
    });

    rows.push(...(res.delegation_responses ?? []));
    nextKey = res.pagination?.next_key || null;
    if (!nextKey) {
      truncated = false;
      break;
    }
  }

  // BigInt: a large validator's stake exceeds what a double can hold exactly,
  // and an off-by-a-few-uatom sort would reorder equal-looking delegations.
  const parsed = rows
    .map((r) => ({
      address: r.delegation?.delegator_address ?? "",
      raw: BigInt((r.balance?.amount ?? "0").split(".")[0] || "0"),
    }))
    .filter((d) => d.address);

  parsed.sort((a, b) => (a.raw < b.raw ? 1 : a.raw > b.raw ? -1 : 0));
  const totalStake = parsed.reduce((sum, d) => sum + d.raw, BigInt(0));
  return { rows: parsed, totalStake, truncated };
}

/**
 * A validator in either set, found by operator, consensus (valcons) or account
 * address. Lets a URL carrying any of the three land on the validator page.
 */
export async function findValidator(
  chain: ChainConfig,
  match: { operator?: string; valcons?: string },
  toValcons: (pubkey: string) => string | null
): Promise<ValidatorSummary | null> {
  const [active, inactive] = await Promise.all([
    getValidatorsCached(chain).catch(() => [] as ValidatorSummary[]),
    getInactiveValidators(chain).catch(() => [] as ValidatorSummary[]),
  ]);
  for (const v of [...active, ...inactive]) {
    if (match.operator && v.operatorAddress === match.operator) return v;
    if (match.valcons && v.consensusPubkey && toValcons(v.consensusPubkey) === match.valcons) {
      return v;
    }
  }
  return null;
}

/**
 * Bonded validator set, ranked by stake. Pages through the LCD because several
 * chains cap page size well below their validator count.
 */
/** Every validator in one staking status, paging through the whole set. */
async function readSet(chain: ChainConfig, status: string): Promise<RawValidator[]> {
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
          status,
          "pagination.limit": 200,
          ...(nextKey ? { "pagination.key": nextKey } : {}),
        },
      }
    );

    collected.push(...res.validators);
    nextKey = res.pagination?.next_key ?? null;
    if (!nextKey) break;
  }
  return collected;
}

function toSummary(v: RawValidator, rank: number, power: number, running: number): ValidatorSummary {
  return {
    rank,
    operatorAddress: v.operator_address,
    moniker: v.description?.moniker?.trim() || v.operator_address,
    website: v.description?.website ?? "",
    identity: v.description?.identity ?? "",
    jailed: v.jailed,
    status: v.status,
    tokens: v.tokens,
    delegatorShares: v.delegator_shares,
    consensusPubkey: v.consensus_pubkey?.key ?? null,
    votingPower: power,
    cumulativePower: running,
    commissionRate: Number(v.commission?.commission_rates?.rate ?? 0),
  };
}

export async function getValidators(chain: ChainConfig): Promise<ValidatorSummary[]> {
  const ranked = (await readSet(chain, "BOND_STATUS_BONDED"))
    .slice()
    .sort((a, b) => Number(b.tokens) - Number(a.tokens));

  const totalBonded = ranked.reduce((sum, v) => sum + Number(v.tokens), 0);

  let running = 0;
  return ranked.map((v, i) => {
    const power = totalBonded > 0 ? Number(v.tokens) / totalBonded : 0;
    running += power;
    return toSummary(v, i + 1, power, running);
  });
}

/**
 * Validators outside the active set - unbonding and unbonded, jailed ones
 * included - largest first. They hold no voting power, so share and cumulative
 * share are zero, and rank is position within this list.
 *
 * Changes only when a validator enters or leaves the set, so fresh for five
 * minutes and served stale for half an hour while a refresh runs.
 */
export function getInactiveValidators(chain: ChainConfig): Promise<ValidatorSummary[]> {
  return cached(
    `validators-inactive:${chain.chainId}`,
    5 * 60_000,
    async () => {
      const [unbonding, unbonded] = await Promise.all([
        readSet(chain, "BOND_STATUS_UNBONDING"),
        readSet(chain, "BOND_STATUS_UNBONDED"),
      ]);
      return [...unbonding, ...unbonded]
        .sort((a, b) => Number(b.tokens) - Number(a.tokens))
        .map((v, i) => toSummary(v, i + 1, 0, 0));
    },
    { staleMs: 30 * 60_000 }
  );
}

/**
 * The Keybase username behind a validator's published identity (a PGP key
 * suffix), or null. Cached for a day: identities almost never change, and the
 * lookup is a third-party call we should not repeat per view.
 */
export function keybaseUsername(identity: string): Promise<string | null> {
  const id = identity.trim();
  if (!/^[0-9A-Fa-f]{16}$/.test(id)) return Promise.resolve(null);
  return cached(
    `keybase:${id.toUpperCase()}`,
    24 * 60 * 60_000,
    async () => {
      try {
        const res = await fetch(
          `https://keybase.io/_/api/1.0/user/lookup.json?key_suffix=${id}&fields=basics`,
          { cache: "no-store", signal: AbortSignal.timeout(3000) }
        );
        if (!res.ok) return null;
        const json = (await res.json()) as {
          them?: { basics?: { username?: string } }[];
        };
        return json.them?.[0]?.basics?.username ?? null;
      } catch {
        return null;
      }
    }
  );
}
