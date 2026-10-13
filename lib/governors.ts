import type { ChainConfig } from "@/lib/chains";
import { cached } from "@/lib/cache";
import { fetchLcd } from "@/lib/lcd";
import { convertAddress } from "@/lib/bech32";
import { getInactiveValidators, getValidatorsCached, type ValidatorSummary } from "@/lib/validators";
import { getAllProposals, isVoting } from "@/lib/proposals";

/**
 * AtomOne's governors (x/gov, atomone-hub/atomone proto/atomone/gov/v1).
 *
 * A governor is an account that votes for whoever delegates their governance
 * power to it. Its power is the bonded stake of those delegators: the chain
 * keeps it as delegation shares per validator (`vshares`), which convert to
 * tokens at each validator's own rate. The governor's `atonegov1…` address is
 * the same key as an ordinary account, and it votes from that account, so its
 * voting record is that account's votes.
 *
 * Routes, from the proto's http options:
 *   /atomone/gov/v1/governors
 *   /atomone/gov/v1/governors/{governor_address}
 *   /atomone/gov/v1/governors/{governor_address}/delegations
 *   /atomone/gov/v1/delegations/{delegator_address}
 *   /atomone/gov/v1/vshares/{governor_address}
 */

export interface Governor {
  /** atonegov1… */
  address: string;
  /** The same key as an account (atone1…): where it votes from. */
  account: string | null;
  active: boolean;
  moniker: string;
  identity: string;
  website: string;
  securityContact: string;
  details: string;
  /** When the status last changed: for an active governor, since when. */
  statusSince: string | null;
}

interface RawGovernor {
  governor_address: string;
  status?: string;
  description?: {
    moniker?: string;
    identity?: string;
    website?: string;
    security_contact?: string;
    details?: string;
  };
  last_status_change_time?: string | null;
}

/** A page cap: governors and their delegators are few, but never read forever. */
const MAX_PAGES = 50;

async function readAll<T>(
  chain: ChainConfig,
  path: string,
  field: string,
  limit = 500
): Promise<T[]> {
  const out: T[] = [];
  let key: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: Record<string, unknown> & { pagination?: { next_key?: string | null } } =
      await fetchLcd(chain, path, {
        cache: "no-store",
        searchParams: { "pagination.limit": limit, ...(key ? { "pagination.key": key } : {}) },
      });
    out.push(...((res[field] as T[] | undefined) ?? []));
    key = res.pagination?.next_key || null;
    if (!key) break;
  }
  return out;
}

function toGovernor(chain: ChainConfig, g: RawGovernor): Governor {
  const d = g.description ?? {};
  return {
    address: g.governor_address,
    account: convertAddress(g.governor_address, chain.bech32Prefix),
    active: g.status === "GOVERNOR_STATUS_ACTIVE",
    moniker: d.moniker?.trim() || g.governor_address,
    identity: d.identity ?? "",
    website: d.website ?? "",
    securityContact: d.security_contact ?? "",
    details: d.details ?? "",
    statusSince: g.last_status_change_time ?? null,
  };
}

/** Every governor, active and inactive. */
export function getGovernors(chain: ChainConfig): Promise<Governor[]> {
  return cached(
    `governors:${chain.chainId}`,
    60_000,
    async () =>
      (await readAll<RawGovernor>(chain, "/atomone/gov/v1/governors", "governors")).map((g) =>
        toGovernor(chain, g)
      ),
    { staleMs: 10 * 60_000 }
  );
}

export async function getGovernor(chain: ChainConfig, address: string): Promise<Governor | null> {
  const all = await getGovernors(chain).catch(() => [] as Governor[]);
  const hit = all.find((g) => g.address === address);
  if (hit) return hit;
  try {
    const res = await fetchLcd<{ governor?: RawGovernor }>(
      chain,
      `/atomone/gov/v1/governors/${address}`,
      { cache: "no-store" }
    );
    return res.governor ? toGovernor(chain, res.governor) : null;
  } catch {
    return null;
  }
}

export interface GovernorPower {
  /** Bonded tokens behind the governor, base units. */
  tokens: bigint;
  /** Where that stake sits, largest first. */
  byValidator: { validator: ValidatorSummary | null; operator: string; tokens: bigint }[];
}

/** Shares of `v` in tokens, through BigInt-scaled decimals so large stakes stay exact. */
function sharesToTokens(shares: string, v: ValidatorSummary | undefined): bigint {
  const scale = BigInt(10) ** BigInt(18);
  const dec = (s: string) => {
    const [i, f = ""] = s.split(".");
    return BigInt(i || "0") * scale + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
  };
  const sh = dec(shares);
  if (!v?.delegatorShares) return sh / scale;
  const total = dec(v.delegatorShares);
  if (total === BigInt(0)) return BigInt(0);
  return (sh * BigInt(v.tokens || "0")) / total;
}

/** The governor's voting power, from its validator shares. */
export function getGovernorPower(chain: ChainConfig, address: string): Promise<GovernorPower> {
  return cached(
    `governor-power:${chain.chainId}:${address}`,
    5 * 60_000,
    async () => {
      const [shares, active, inactive] = await Promise.all([
        readAll<{ validator_address: string; shares: string }>(
          chain,
          `/atomone/gov/v1/vshares/${address}`,
          "val_shares"
        ),
        getValidatorsCached(chain).catch(() => [] as ValidatorSummary[]),
        getInactiveValidators(chain).catch(() => [] as ValidatorSummary[]),
      ]);
      const byOperator = new Map([...active, ...inactive].map((v) => [v.operatorAddress, v]));
      const byValidator = shares
        .map((s) => {
          const v = byOperator.get(s.validator_address);
          return { validator: v ?? null, operator: s.validator_address, tokens: sharesToTokens(s.shares, v) };
        })
        .filter((s) => s.tokens > BigInt(0))
        .sort((a, b) => (a.tokens < b.tokens ? 1 : a.tokens > b.tokens ? -1 : 0));
      return { tokens: byValidator.reduce((sum, s) => sum + s.tokens, BigInt(0)), byValidator };
    },
    { staleMs: 30 * 60_000 }
  );
}

/** Accounts that delegated their governance power to this governor. */
export function getGovernorDelegators(chain: ChainConfig, address: string): Promise<string[]> {
  return cached(
    `governor-delegators:${chain.chainId}:${address}`,
    5 * 60_000,
    async () =>
      (
        await readAll<{ delegator_address: string }>(
          chain,
          `/atomone/gov/v1/governors/${address}/delegations`,
          "delegations"
        )
      ).map((d) => d.delegator_address),
    { staleMs: 30 * 60_000, group: { name: "governor-delegators", max: 24 } }
  );
}

/** The governor an account delegated its governance power to, or null. */
export function governorOf(chain: ChainConfig, account: string): Promise<string | null> {
  return cached(`governor-of:${chain.chainId}:${account}`, 5 * 60_000, async () => {
    try {
      const res = await fetchLcd<{ governor_address?: string }>(
        chain,
        `/atomone/gov/v1/delegations/${account}`,
        { cache: "no-store" }
      );
      return res.governor_address || null;
    } catch {
      // The chain answers "not found" for an account with no governor.
      return null;
    }
  });
}

export interface GovernorRow extends Governor {
  tokens: bigint;
  delegators: number;
  validators: number;
}

/** Every governor with its power and following, largest first. */
export function getGovernorTable(chain: ChainConfig): Promise<GovernorRow[]> {
  return cached(
    `governor-table:${chain.chainId}`,
    2 * 60_000,
    async () => {
      const governors = await getGovernors(chain);
      const rows = await Promise.all(
        governors.map(async (g) => {
          const [power, delegators] = await Promise.all([
            getGovernorPower(chain, g.address).catch(() => null),
            getGovernorDelegators(chain, g.address).catch(() => null),
          ]);
          return {
            ...g,
            tokens: power?.tokens ?? BigInt(0),
            delegators: delegators?.length ?? 0,
            validators: power?.byValidator.length ?? 0,
          };
        })
      );
      return rows.sort((a, b) =>
        a.active !== b.active ? (a.active ? -1 : 1) : a.tokens < b.tokens ? 1 : a.tokens > b.tokens ? -1 : 0
      );
    },
    { staleMs: 15 * 60_000 }
  );
}

export interface OpenVote {
  proposalId: string;
  title: string;
  votingEndTime: string | null;
  /** The governor's vote, or null when it has not voted yet. */
  options: { option: string; weight: number }[] | null;
}

/**
 * The governor's votes on proposals still in voting, from the chain. Its
 * record on closed proposals comes from the index; the chain drops individual
 * votes once a proposal is tallied, so this is what a chain the indexer does
 * not cover can show.
 */
export function governorOpenVotes(chain: ChainConfig, account: string): Promise<OpenVote[]> {
  return cached(`governor-open-votes:${chain.chainId}:${account}`, 60_000, async () => {
    const open = (await getAllProposals(chain)).filter((p) => isVoting(p.status));
    return Promise.all(
      open.map(async (p) => {
        let options: OpenVote["options"] = null;
        try {
          const res = await fetchLcd<{ vote?: { options?: { option: string; weight: string }[] } }>(
            chain,
            `/cosmos/gov/v1/proposals/${p.id}/votes/${account}`,
            { cache: "no-store" }
          );
          options = (res.vote?.options ?? []).map((o) => ({ option: o.option, weight: Number(o.weight) }));
        } catch {
          // Not found: no vote yet.
        }
        return { proposalId: p.id, title: p.title, votingEndTime: p.votingEndTime, options };
      })
    );
  });
}
