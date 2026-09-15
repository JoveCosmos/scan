import { Rpc } from "./rpc";
import {
  commitHeight,
  commitSignatures,
  resolveMissed,
  type BlockResponse,
  type MissedSignatureRow,
} from "./extract";

/**
 * The validator set a commit's signatures are positional against.
 *
 * An absent slot carries no validator address - the node says a vote is missing
 * but not whose - so attribution needs the set as it stood at that height.
 * Fetching it per block would double the request count, so it is cached per
 * chain and refetched only when a commit stops lining up. On a stable chain
 * that is a handful of times a day against blocks arriving every six seconds.
 *
 * Module-level rather than per-pass so the cache survives across batches, and
 * shared by the live worker and the backfill because a refill that skipped this
 * would write blocks with no absences and call them complete.
 */
const sets = new Map<string, string[]>();

export async function missedIn(
  rpc: Rpc,
  chainId: string,
  block: BlockResponse
): Promise<MissedSignatureRow[]> {
  const sigs = commitSignatures(block);
  const height = commitHeight(block);
  if (sigs.length === 0 || !height) return [];

  // Resolve against a LOCAL copy, never the map, so two heights fetched
  // concurrently cannot validate against each other's set mid-update.
  let set = sets.get(chainId) ?? [];
  let r = resolveMissed(sigs, set, height);

  if (r.mismatch) {
    set = await rpc.validatorSet(Number(height));
    sets.set(chainId, set);
    r = resolveMissed(sigs, set, height);
  }

  if (r.mismatch) {
    // Refusing to write is the correct failure. A set that still will not align
    // after a fresh fetch would pin downtime on whichever validator happens to
    // sit at that index, which is a lie about someone's service. Say so loudly;
    // the height keeps its lower extract_version and can be refilled.
    console.warn(
      `[commit] ${chainId}: set will not align at height ${height}, wrote no absences`
    );
    return [];
  }
  return r.missed;
}

/** Test seam: forget every cached set. */
export function resetCommitSets(): void {
  sets.clear();
}
