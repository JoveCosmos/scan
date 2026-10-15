import type { ChainConfig } from "@/lib/chains";
import type { ValidatorSummary } from "@/lib/validators";
import type { ValidatorRow } from "@/components/validators-table";
import type { JailCounts } from "@/lib/indexer-db";
import { getAdapter } from "@/lib/adapter";
import { withinBudget } from "@/lib/cache";
import { jailCounts } from "@/lib/indexer-db";
import { formatToken } from "@/lib/overview";
import { policyFor } from "@/lib/tiers";
import { consensusIdsFromPubkey, emptyUptime } from "@/lib/uptime";
import { validatorLogoMap } from "@/lib/validator-logos";

/** A validator's jailing record from the index, matched on its consensus address. */
export function jailingsOf(chain: ChainConfig, jailings: JailCounts | null, consensusPubkey: string | null) {
  if (!jailings || !consensusPubkey) return null;
  const ids = consensusIdsFromPubkey(consensusPubkey, chain.bech32Prefix);
  if (!ids) return null;
  return {
    count: jailings.byConsAddr.get(ids.valcons) ?? 0,
    tombstoned: jailings.tombstoned.has(ids.valcons),
  };
}

/**
 * The validators outside the active set as table rows. Outside the set there
 * is no signing to measure and no 24h baseline, and a self-bond read per
 * inactive validator would be hundreds of requests for a column few would sort
 * by - so those stay empty. Jail records do apply.
 *
 * Read when someone opens the Inactive view rather than with the page: on the
 * Cosmos Hub they are 467 of its 647 rows.
 */
export async function inactiveValidatorRows(chain: ChainConfig): Promise<ValidatorRow[]> {
  const adapter = getAdapter(chain);
  const [inactive, jailings] = await Promise.all([
    adapter.getInactiveValidators().catch(() => [] as ValidatorSummary[]),
    policyFor(chain).metrics ? withinBudget(jailCounts(chain.chainId), 2500, null) : null,
  ]);
  const logos = await validatorLogoMap(chain, inactive);
  return inactive.map((v) => ({
    rank: v.rank,
    operatorAddress: v.operatorAddress,
    moniker: v.moniker,
    logos: logos.get(v.operatorAddress) ?? [],
    votingPower: 0,
    cumulativePower: 0,
    tokens: v.tokens,
    tokensLabel: formatToken(v.tokens, chain.exponent),
    commissionRate: v.commissionRate,
    jailed: v.jailed,
    status: v.status,
    uptime: emptyUptime(),
    delta: null,
    jailings: jailingsOf(chain, jailings, v.consensusPubkey),
    selfBond: null,
  }));
}
