import type { ChainConfig } from "@/lib/chains";

export type SearchKind =
  | "height"
  | "tx"
  | "validator"
  | "account"
  | "address"
  | "unknown";

export interface SearchGuess {
  kind: SearchKind;
  /** Normalised value to route with. */
  value: string;
}

/**
 * Classify a search term for one chain. Deliberately syntactic — it never hits
 * the network — so the caller decides how to resolve an ambiguous "address"
 * (which on gno may be either a consensus validator or a plain account).
 */
export function classifyQuery(chain: ChainConfig, raw: string): SearchGuess {
  const q = raw.trim();
  if (!q) return { kind: "unknown", value: q };

  // A bare number is a block height.
  if (/^\d+$/.test(q)) return { kind: "height", value: q };

  // Cosmos tx hashes are 64 hex characters.
  if (/^[0-9a-fA-F]{64}$/.test(q)) return { kind: "tx", value: q.toUpperCase() };

  const prefix = chain.bech32Prefix;

  // Operator addresses are the only ones with a dedicated staking profile.
  if (prefix && q.startsWith(`${prefix}valoper1`)) {
    return { kind: "validator", value: q };
  }

  // Bech32 account address for this chain (gno uses the bare "g" prefix).
  if (prefix && new RegExp(`^${prefix}1[02-9ac-hj-np-z]{6,}$`).test(q)) {
    return { kind: "address", value: q };
  }

  // gno tx hashes are base64: 44 chars, often with +/= which survive a URL round
  // trip only when encoded. Checked after addresses so "g1..." wins.
  if (/^[A-Za-z0-9+/]{43}=$/.test(q)) return { kind: "tx", value: q };

  return { kind: "unknown", value: q };
}
