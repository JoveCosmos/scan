import type { ChainConfig } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { getSelfBonds } from "@/lib/staking";
import { policyFor } from "@/lib/tiers";
import { getChainParams, getChainEconomics, getAprModel } from "@/lib/params";
import { jailCounts } from "@/lib/indexer-db";
import { missedLast30d } from "@/lib/indexer-validator";
import { validatorLogoMap } from "@/lib/validator-logos";

/**
 * Fill the caches behind the validator list for one Cosmos chain.
 *
 * Every deploy restarts the server with empty caches, and the self-bond read
 * alone is a request per validator (~3s on a 100-validator set); on AtomOne
 * the index's grouped reads (jail counts, 30-day misses) and the Keybase logo
 * lookups made the first view take over 30 s. Doing it at
 * boot means the first visitor after a deploy gets the same answer as the
 * next one. Afterwards stale-while-revalidate keeps it warm on its own.
 */
export async function warmValidators(chain: ChainConfig): Promise<void> {
  if (chain.kind !== "cosmos") return;
  const adapter = getAdapter(chain);
  const validators = await adapter.getValidators();
  const metrics = policyFor(chain).metrics;
  const params = await getChainParams(chain).catch(() => null);
  const tax = params?.distribution?.communityTax ?? null;
  await Promise.allSettled([
    getSelfBonds(chain, validators),
    adapter
      .getInactiveValidators()
      .then((inactive) => validatorLogoMap(chain, [...validators, ...inactive], 0)),
    getChainEconomics(chain, tax, null),
    getAprModel(chain, tax, validators.map((v) => v.tokens)),
    // The index's grouped reads: the slowest part of a cold AtomOne page.
    metrics ? jailCounts(chain.chainId) : Promise.resolve(),
    missedLast30d(chain.chainId),
    metrics ? adapter.getUptime(validators) : Promise.resolve(),
    metrics
      ? adapter
          .getOverview()
          .then((o) => adapter.getStakeDeltas(validators, o.height ?? null))
      : Promise.resolve(),
  ]);
}
