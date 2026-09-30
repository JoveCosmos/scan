/** Compact relative age, e.g. "6s ago". Safe against null/invalid timestamps. */
export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "-";
  const delta = (now - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(delta)) return "-";
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

/** "cosmosvaloper1abc…xyz9" - keeps both ends, which are the identifying parts. */
export function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * A validator's jail record, worded the same everywhere it appears: the list,
 * the validator page, and anywhere later. Zero is "Never", never "0" - a bare
 * zero reads as a missing figure, not a clean record. Null means the index
 * cannot say, which is not the same claim and must not look like it.
 */
export function jailRecord(
  jailings: { count: number; tombstoned: boolean } | null
): string {
  if (!jailings) return "-";
  if (jailings.tombstoned) return "Tombstoned";
  if (jailings.count === 0) return "Never";
  if (jailings.count === 1) return "Once";
  return `${jailings.count} times`;
}

/**
 * Time left until a moment, e.g. "in 4d 6h". Past moments read "ended" rather
 * than a relative age - timeAgo on a future date is what printed "ends just
 * now" for a vote with five days to run. Null for a missing or invalid date.
 */
export function timeUntil(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const delta = t - now;
  if (delta <= 0) return "ended";
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "30 Sep 2026", in UTC. Deterministic on purpose: a date rendered in the
 * server's locale and again in the browser's is a hydration mismatch.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "30 Sep 2026, 23:20 UTC". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)}, ${hh}:${mm} UTC`;
}

/**
 * Upper-case hex from base64, for block and header hashes: the LCD renders
 * them in base64, explorers and every other tool in hex. Works in the browser
 * (atob) as well as on the server. Input that is already hex, or will not
 * decode, comes back unchanged.
 */
export function base64ToHex(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  if (/^[0-9a-fA-F]+$/.test(value)) return value.toUpperCase();
  try {
    const bin = atob(value);
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex.toUpperCase();
  } catch {
    return value;
  }
}

/**
 * An integer base-unit amount scaled by its decimals, exactly: BigInt all the
 * way, since balances routinely exceed what a double holds. A null exponent
 * means the decimals are unknown, so the base units are shown as they are
 * rather than scaled by a guess. Non-integer input is returned untouched.
 */
export function formatUnits(raw: string, exponent: number | null): string {
  if (!/^\d+$/.test(raw)) return raw;
  const value = BigInt(raw);
  if (exponent === null || exponent <= 0) return value.toLocaleString("en-US");
  const base = BigInt(10) ** BigInt(exponent);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(exponent, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Sum integer base-unit amounts exactly. Non-integer parts are skipped. */
export function sumUnits(amounts: (string | null | undefined)[]): string {
  let total = BigInt(0);
  for (const a of amounts) if (a && /^\d+$/.test(a)) total += BigInt(a);
  return total.toString();
}
