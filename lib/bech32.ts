import { bech32 } from "bech32";

/**
 * The same account key produces a different address on every chain — only the
 * human-readable prefix changes, the 20-byte payload does not. So an address on
 * one chain can be re-encoded to its counterpart elsewhere without any lookup.
 *
 * This holds for standard secp256k1 accounts. It does NOT hold for module
 * accounts or contract addresses, which are chain-local by construction, and
 * the counterpart may simply never have been used.
 */

/** Chains offered in the address switcher, mainnet only, in display order. */
export const LINKED_CHAINS = [
  { chainId: "cosmoshub-4", prefix: "cosmos", label: "Cosmos Hub" },
  { chainId: "atomone-1", prefix: "atone", label: "AtomOne" },
  { chainId: "akashnet-2", prefix: "akash", label: "Akash" },
  { chainId: "gnoland-1", prefix: "g", label: "Gno.land" },
] as const;

export interface LinkedAddress {
  chainId: string;
  prefix: string;
  label: string;
  address: string;
}

/** Re-encode an address under a different prefix. Null if it will not decode. */
export function convertAddress(address: string, toPrefix: string): string | null {
  try {
    const { words } = bech32.decode(address);
    return bech32.encode(toPrefix, words);
  } catch {
    return null;
  }
}

/**
 * The account behind a validator operator address.
 *
 * `cosmosvaloper1abc…` and `cosmos1abc…` carry the same 20 bytes — the operator
 * form is just the same key under a different prefix. That account is the
 * validator's self-delegation address, so this is the link from a validator
 * page to its balances and transaction history.
 */
export function accountFromOperator(
  operatorAddress: string,
  bech32Prefix: string
): string | null {
  const prefix = decodePrefix(operatorAddress);
  if (!prefix) return null;
  // Only meaningful for an operator address; a plain account is already there.
  if (!prefix.endsWith("valoper")) return null;
  return convertAddress(operatorAddress, bech32Prefix);
}

export function decodePrefix(address: string): string | null {
  try {
    return bech32.decode(address).prefix;
  } catch {
    return null;
  }
}

/**
 * The same account across every chain in LINKED_CHAINS, including the one it
 * was given as. Empty when the input is not a decodable account address —
 * validator (`…valoper1…`) addresses are deliberately excluded, since their
 * counterparts are not the same entity.
 */
export function linkedAddresses(address: string): LinkedAddress[] {
  const prefix = decodePrefix(address);
  if (!prefix) return [];
  // Operator/consensus addresses are a different namespace; do not offer them.
  if (/valoper|valcons/.test(prefix)) return [];

  return LINKED_CHAINS.flatMap((chain) => {
    const converted = convertAddress(address, chain.prefix);
    return converted ? [{ ...chain, address: converted }] : [];
  });
}
