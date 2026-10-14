import { bech32 } from "bech32";

/**
 * Where an address goes when clicked. One rule set for the whole app, so no
 * page decides on its own and gets it wrong: a validator's operator address
 * opened as an empty account, an Osmosis address opened on Cosmos Hub.
 *
 * Pure and dependency-light on purpose: the server calls it with the chain
 * configs, the browser with the same list shipped through ChainDirectory.
 */

export interface ChainPrefix {
  chainId: string;
  /** Account prefix, e.g. "cosmos"; operator and consensus add valoper/valcons. */
  bech32Prefix: string;
  network: "mainnet" | "testnet";
}

export type AddressKind = "account" | "validator" | "consensus" | "governor";

export interface AddressRoute {
  chainId: string;
  kind: AddressKind;
  href: string;
  /** The address as it should be shown and routed: lower-cased bech32. */
  address: string;
}

/** gno.land realm and package paths live on gno.land itself. */
const GNO_PATH = /^gno\.land\/[pr]\/[\w\-./]+$/;

export function decodeBech32(input: string): { prefix: string; address: string } | null {
  const address = input.trim().toLowerCase();
  try {
    // Contract addresses (32 bytes) exceed bech32's default 90-char limit.
    const { prefix } = bech32.decode(address, 128);
    return { prefix, address };
  } catch {
    return null;
  }
}

/**
 * Route an address. The current chain wins when the prefix fits it (testnets
 * share their mainnet's prefix); otherwise the first mainnet with that prefix,
 * then any chain with it. Null when nothing we carry uses the prefix - the
 * caller then shows plain text rather than a link to an empty page.
 */
export function routeAddress(
  input: string | null | undefined,
  currentChainId: string | null | undefined,
  chains: readonly ChainPrefix[]
): AddressRoute | null {
  if (!input) return null;
  const decoded = decodeBech32(input);
  if (!decoded) return null;
  const { prefix, address } = decoded;

  let kind: AddressKind = "account";
  let base = prefix;
  if (prefix.endsWith("valoper")) {
    kind = "validator";
    base = prefix.slice(0, -"valoper".length);
  } else if (prefix.endsWith("valcons")) {
    kind = "consensus";
    base = prefix.slice(0, -"valcons".length);
  } else if (prefix.endsWith("gov") && chains.some((c) => c.bech32Prefix === prefix.slice(0, -3))) {
    // AtomOne governors: atonegov1… is the governor behind an atone1… account.
    kind = "governor";
    base = prefix.slice(0, -"gov".length);
  }

  const matches = chains.filter((c) => c.bech32Prefix === base);
  if (matches.length === 0) return null;
  const chain =
    matches.find((c) => c.chainId === currentChainId) ??
    matches.find((c) => c.network === "mainnet") ??
    matches[0];

  const section =
    kind === "account" ? "accounts" : kind === "governor" ? "governors" : "validators";
  return {
    chainId: chain.chainId,
    kind,
    address,
    href: `/${chain.chainId}/${section}/${address}`,
  };
}

/** Scan's page for a gno.land package: the path without its gno.land/ domain. */
export function packageHref(chainId: string, path: string): string {
  return `/${chainId}/packages/${path.replace(/^gno\.land\//, "")}`;
}

/** External page for a gno.land realm or package path, or null. */
export function gnoPathHref(path: string | null | undefined): string | null {
  if (!path) return null;
  return GNO_PATH.test(path) ? `https://${path}` : null;
}
