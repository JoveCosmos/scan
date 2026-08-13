/**
 * Shape checks for URL-supplied identifiers, applied before anything is
 * fetched with them.
 *
 * Route params are interpolated into LCD and RPC paths, and `decodeParam`
 * percent-decodes them first — so without these, `%2F..%2F` arrives as
 * `/../`, which URL normalisation folds away, letting a crafted Scan URL
 * steer our server's request to any path on the node, or smuggle `?` query
 * params past ours. The data on the other side is public, but the request is
 * ours, and a response from the wrong endpoint parses as "not found" rather
 * than as an error — invisible until someone wonders why a page is empty.
 *
 * Every check is a strict whitelist of the identifier's real shape, so no
 * legitimate value is ever rejected; anything else earns a 404 before a
 * single byte leaves the box. The search box already works this way
 * (lib/search.ts), which left the detail routes as the only unguarded door.
 */

/** Block heights and proposal ids: bare digits, bounded well past any chain. */
export function isNumericId(value: string | number): boolean {
  return /^\d{1,15}$/.test(String(value));
}

/** A Cosmos SDK tx hash: 64 hex chars, either case. */
export function isCosmosTxHash(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * A bech32 address, loosely: lowercase alphanumerics at plausible length.
 * Full checksum validation belongs to the chain — the job here is only to
 * keep `/`, `?`, `#`, `.` and their encoded forms out of a URL path. The 90
 * ceiling is bech32's own (BIP-173); valoper addresses sit near 50.
 */
export function isBech32ish(value: string): boolean {
  return /^[a-z0-9]{8,90}$/.test(value);
}
