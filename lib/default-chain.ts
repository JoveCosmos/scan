/**
 * A reference chain, used only where some chain's bech32 prefix is needed to
 * classify a query. It is NOT a preferred network: search deliberately has no
 * default, and an ambiguous query asks which chain rather than picking one.
 *
 * Deliberately its own module with no imports. It lives apart from lib/chains
 * because that module reads the config directory with node:fs, and importing
 * the constant from there into a client component would drag fs into the
 * browser bundle.
 */
export const DEFAULT_CHAIN_ID = "atomone-1";
