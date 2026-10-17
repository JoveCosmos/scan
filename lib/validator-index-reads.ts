import { commissionEarned, proposerStats, slashHistory, stakeHistory } from "@/lib/indexer-db";
import {
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
 * Every index read a validator page makes, as plain functions, which the page
 * wraps in React's per-request cache (see its sections). A failed read is
 * null, never an error.
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
