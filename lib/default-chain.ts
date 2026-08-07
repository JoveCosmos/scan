/**
 * The chain assumed when the URL names none — the landing page, the header
 * before you have picked anything, and search without a chain hint.
 *
 * Deliberately its own module with no imports. It lives apart from lib/chains
 * because that module reads the config directory with node:fs, and the header
 * is a client component: importing the constant from there would drag fs into
 * the browser bundle and stop the header hydrating.
 */
export const DEFAULT_CHAIN_ID = "atomone-1";
