import { createHash } from "node:crypto";
import { bech32 } from "bech32";

/**
 * An address no key controls, derived from a name: the first 20 bytes of
 * sha256(preimage), bech32 under `prefix`. Cosmos module accounts
 * (sha256("photon")), ICS-20 escrows and gno.land realm accounts
 * (sha256("pkgPath:" + path)) are all made this way.
 */
export function hashedAddress(prefix: string, preimage: string | Uint8Array): string {
  const bytes = createHash("sha256").update(preimage).digest().subarray(0, 20);
  return bech32.encode(prefix, bech32.toWords(bytes));
}
