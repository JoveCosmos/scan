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

/** "cosmosvaloper1abc…xyz9" — keeps both ends, which are the identifying parts. */
export function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
