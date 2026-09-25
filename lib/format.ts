/** Compact relative age, e.g. "6s ago". Safe against null/invalid timestamps. */
export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(delta)) return "—";
  if (delta < 1) return "just now";
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/**
 * Next hands dynamic route params through still percent-encoded, which matters
 * for gno's base64 tx hashes (they contain "+", "/" and "="). Decoding is a
 * no-op for Cosmos hex hashes, and malformed input is returned untouched.
 */
export function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** "cosmosvaloper1abc…xyz9" — keeps both ends, which are the identifying parts. */
export function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * A validator's jail record, worded the same everywhere it appears: the list,
 * the validator page, and anywhere later. Zero is "Never", never "0" — a bare
 * zero reads as a missing figure, not a clean record. Null means the index
 * cannot say, which is not the same claim and must not look like it.
 */
export function jailRecord(
  jailings: { count: number; tombstoned: boolean } | null
): string {
  if (!jailings) return "—";
  if (jailings.tombstoned) return "Tombstoned";
  if (jailings.count === 0) return "Never";
  if (jailings.count === 1) return "Once";
  return `${jailings.count} times`;
}
