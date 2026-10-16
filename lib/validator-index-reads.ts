import { commissionEarned, proposerStats, slashHistory, stakeHistory } from "@/lib/indexer-db";
import {
  commissionHistory,
  consHexOf,
  powerEvents,
  powerHistory,
  proposedBlocks,
  proposerFairness,
  signingHistory,
  validatorCreatedAt,
  validatorEvents,
  validatorVotes,
  voterRecasts,
} from "@/lib/indexer-validator";

/**
 * Every index read a validator page makes, as plain functions. The page wraps
 * them in React's per-request cache (see its sections); the boot warm-up calls
 * them directly with the same arguments, so it fills exactly the caches a
 * visit reads. A failed read is null, never an error.
 */

const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const readEvents = (chainId: string, account: string) => soft(validatorEvents(chainId, account));
export const readSlashes = (chainId: string, valcons: string, addr: string) =>
  soft(slashHistory(chainId, valcons, addr));
export const readProposer = (chainId: string, hex: string) => soft(proposerStats(chainId, hex));
export const readFairness = (chainId: string, addr: string, hex: string) =>
  soft(proposerFairness(chainId, addr, hex));
export const readProposed = (chainId: string, hex: string) => soft(proposedBlocks(chainId, hex));
export const readEarned = (chainId: string, account: string) => soft(commissionEarned(chainId, account));
export const readPowerEvents = (chainId: string, addr: string) => soft(powerEvents(chainId, addr));
export const readStake = (chainId: string, addr: string) => soft(stakeHistory(chainId, addr));
export const readRecasts = (chainId: string, account: string) => soft(voterRecasts(chainId, account));
export const readCommissionHistory = (chainId: string, addr: string, account: string | null) =>
  soft(commissionHistory(chainId, addr, account));

/** The key the index files signing under: derived from the pubkey, else looked up. */
export const readConsHex = async (chainId: string, addr: string, hex: string | null) =>
  hex ?? soft(consHexOf(chainId, addr));
export const readSigningHistAt = (chainId: string, consHex: string) => soft(signingHistory(chainId, consHex));
export const readPowerHistAt = (chainId: string, consHex: string) => soft(powerHistory(chainId, consHex));

/** Votes are counted from the validator's creation, where the index holds it. */
export async function readVotes(chainId: string, account: string) {
  const created = await soft(validatorCreatedAt(chainId, account));
  return soft(validatorVotes(chainId, account, created));
}

/**
 * Read everything a validator page reads from the index, one query at a time
 * (the index has four connections, and visitors come first).
 */
export async function warmValidatorIndex(
  chainId: string,
  addr: string,
  account: string | null,
  ids: { valcons: string; hex: string } | null
): Promise<void> {
  const hex = await readConsHex(chainId, addr, ids?.hex ?? null);
  const reads: (() => Promise<unknown> | null)[] = [
    () => (account ? readEarned(chainId, account) : null),
    () => (ids ? readProposer(chainId, ids.hex) : null),
    () => (ids ? readFairness(chainId, addr, ids.hex) : null),
    () => (account ? readVotes(chainId, account) : null),
    () => readCommissionHistory(chainId, addr, account),
    () => (hex ? readSigningHistAt(chainId, hex) : null),
    () => (ids ? readProposed(chainId, ids.hex) : null),
    () => (account ? readRecasts(chainId, account) : null),
    () => (account ? readEvents(chainId, account) : null),
    () => readPowerEvents(chainId, addr),
    () => (hex ? readPowerHistAt(chainId, hex) : null),
    () => readStake(chainId, addr),
    () => (ids ? readSlashes(chainId, ids.valcons, addr) : null),
  ];
  for (const read of reads) await read();
}
