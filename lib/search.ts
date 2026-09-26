import { createHash } from "node:crypto";
import { bech32 } from "bech32";
import type { ChainConfig } from "@/lib/chains";
import { decodeBech32 } from "@/lib/address-route";

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

/** A hex hash, with or without a "0x" in front. Upper-cased, prefix dropped. */
function hexHash(q: string): string | null {
  const bare = q.replace(/^0x/i, "");
  return /^[0-9a-fA-F]{64}$/.test(bare) ? bare.toUpperCase() : null;
}

/**
 * Classify what can be recognised without knowing the chain: a block height and
 * a transaction hash look the same everywhere.
 *
 * This is what chain-agnostic search needs. It exists so that page does not
 * have to nominate an arbitrary chain purely to satisfy a parameter it never
 * uses — there is no default chain, and search should not invent one.
 */
export function classifyChainless(raw: string): SearchGuess {
  const q = raw.trim();
  if (!q) return { kind: "unknown", value: q };

  if (/^\d+$/.test(q)) return { kind: "height", value: q };
  const hex = hexHash(q);
  if (hex) return { kind: "tx", value: hex };

  // gno tx hashes are base64: 43 chars plus "=". Safe to match here even though
  // a bech32 address could in principle collide, because the caller resolves
  // addresses before it considers transactions.
  if (/^[A-Za-z0-9+/]{43}=$/.test(q)) return { kind: "tx", value: q };

  return { kind: "unknown", value: q };
}

/**
 * Classify a search term for one chain. Deliberately syntactic — it never hits
 * the network — so the caller decides how to resolve an ambiguous "address"
 * (which on gno may be either a consensus validator or a plain account).
 * Anything this chain cannot answer is "unknown", and the chain search hands
 * it to the global search.
 */
export function classifyQuery(chain: ChainConfig, raw: string): SearchGuess {
  const q = raw.trim();
  if (!q) return { kind: "unknown", value: q };

  // A bare number is a block height.
  if (/^\d+$/.test(q)) return { kind: "height", value: q };

  // Cosmos tx hashes are 64 hex characters.
  const hex = hexHash(q);
  if (hex) return { kind: "tx", value: hex };

  const prefix = chain.bech32Prefix;
  // Bech32 is case-insensitive but must not be mixed; routes use lower case.
  const decoded = decodeBech32(q);

  // Operator addresses are the only ones with a dedicated staking profile.
  if (prefix && decoded && decoded.prefix === `${prefix}valoper`) {
    return { kind: "validator", value: decoded.address };
  }

  // Bech32 account address for this chain (gno uses the bare "g" prefix).
  if (prefix && decoded && decoded.prefix === prefix) {
    return { kind: "address", value: decoded.address };
  }

  // gno tx hashes are base64: 44 chars, often with +/= which survive a URL round
  // trip only when encoded. Checked after addresses so "g1..." wins.
  if (/^[A-Za-z0-9+/]{43}=$/.test(q)) return { kind: "tx", value: q };

  return { kind: "unknown", value: q };
}

/** What the global search is looking at, before it asks any chain. */
export type SearchShape =
  | { kind: "empty" }
  | { kind: "height"; value: string }
  /** 64 hex, "0x" allowed: a Cosmos tx hash, or a gno one in hex form. */
  | { kind: "txHex"; value: string }
  /** 32 bytes in base64: a gno tx hash or an ed25519 consensus key. */
  | { kind: "base64Key32"; value: string }
  /** A compressed secp256k1 account key, base64 or hex. */
  | { kind: "secpKey"; bytes: Buffer }
  /** 20 bytes of hex: a consensus address as CometBFT prints it. */
  | { kind: "consHex"; value: string }
  | { kind: "bech32"; prefix: string; address: string }
  | { kind: "gnoPath"; value: string }
  | { kind: "name"; value: string };

export function classifySearch(raw: string): SearchShape {
  const q = raw.trim();
  if (!q) return { kind: "empty" };
  if (/^\d+$/.test(q)) return { kind: "height", value: q };

  const hex = hexHash(q);
  if (hex) return { kind: "txHex", value: hex };

  if (/^gno\.land\/[pr]\/[\w\-./]+$/.test(q)) return { kind: "gnoPath", value: q };

  const decoded = decodeBech32(q);
  if (decoded) return { kind: "bech32", prefix: decoded.prefix, address: decoded.address };

  if (/^[A-Za-z0-9+/]{43}=$/.test(q)) {
    if (Buffer.from(q, "base64").length === 32) return { kind: "base64Key32", value: q };
  }
  if (/^[A-Za-z0-9+/]{44}$/.test(q)) {
    const bytes = Buffer.from(q, "base64");
    if (bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3)) return { kind: "secpKey", bytes };
  }
  if (/^(0x)?0[23][0-9a-fA-F]{64}$/.test(q)) {
    return { kind: "secpKey", bytes: Buffer.from(q.replace(/^0x/i, ""), "hex") };
  }
  if (/^(0x)?[0-9a-fA-F]{40}$/.test(q)) {
    return { kind: "consHex", value: q.replace(/^0x/i, "").toUpperCase() };
  }

  return q.length >= 2 ? { kind: "name", value: q } : { kind: "empty" };
}

/**
 * The account address of a compressed secp256k1 key: ripemd160(sha256(key)),
 * the rule every Cosmos SDK chain uses for its accounts.
 */
export function secpKeyToAddress(key: Buffer, prefix: string): string {
  const sha = createHash("sha256").update(key).digest();
  const rip = createHash("ripemd160").update(sha).digest();
  return bech32.encode(prefix, bech32.toWords(rip));
}
