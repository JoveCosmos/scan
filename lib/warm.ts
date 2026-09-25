import type { ChainConfig } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { getSelfBonds } from "@/lib/staking";
import { policyFor } from "@/lib/tiers";

/**
 * Fill the caches behind the validator list for one Cosmos chain.
 *
 * Every deploy restarts the server with empty caches, and the self-bond read
 * alone is a request per validator (~3s on a 100-validator set). Doing it at
 * boot means the first visitor after a deploy gets the same answer as the
 * next one. Afterwards stale-while-revalidate keeps it warm on its own.
 */
export async function warmValidators(chain: ChainConfig): Promise<void> {
  if (chain.kind !== "cosmos") return;
  const adapter = getAdapter(chain);
  const validators = await adapter.getValidators();
  const metrics = policyFor(chain).metrics;
  await Promise.allSettled([
    getSelfBonds(chain, validators),
    adapter.getInactiveValidators(),
    metrics ? adapter.getUptime(validators) : Promise.resolve(),
    metrics
      ? adapter
          .getOverview()
          .then((o) => adapter.getStakeDeltas(validators, o.height ?? null))
      : Promise.resolve(),
  ]);
}
