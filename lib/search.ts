import { createHash } from "node:crypto";
import { bech32 } from "bech32";
import { decodeBech32 } from "@/lib/address-route";

/** A hex hash, with or without a "0x" in front. Upper-cased, prefix dropped. */
function hexHash(q: string): string | null {
  const bare = q.replace(/^0x/i, "");
  return /^[0-9a-fA-F]{64}$/.test(bare) ? bare.toUpperCase() : null;
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
  | { kind: "gnoPath"; value: string; render?: string }
  | { kind: "name"; value: string };

export function classifySearch(raw: string): SearchShape {
  const q = raw.trim();
  if (!q) return { kind: "empty" };
  if (/^\d+$/.test(q)) return { kind: "height", value: q };

  const hex = hexHash(q);
  if (hex) return { kind: "txHex", value: hex };

  // A gno.land package: its path, a gno.land link to it, or a Render path
  // ("gno.land/r/gov/dao:13", whose argument is kept for the render tab).
  const gno = q.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const gnoPath = gno.match(/^(gno\.land\/[pr]\/[\w\-./]+?)(?::(.*))?$/);
  if (gnoPath) return { kind: "gnoPath", value: gnoPath[1].toLowerCase(), render: gnoPath[2] || undefined };

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
