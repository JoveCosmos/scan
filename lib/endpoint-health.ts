/**
 * Which of a chain's endpoints are current.
 *
 * An endpoint can keep answering long after its node stopped following the
 * chain: AtomOne testnet's nodeist REST endpoint sat at block 7,505,168 (10 Jun
 * 2026) for four months, serving 52 validators and one governor where the chain
 * had 44 and four. Every endpoint answers, so failover alone never left it, and
 * once it had answered it was the endpoint tried first (see lib/lcd.ts).
 *
 * So each endpoint's newest block is looked at once a minute. One more than
 * BEHIND_BLOCKS behind the freshest, or with a newest block older than OLD_MS
 * while another endpoint is current, is left out: no answer is better than an
 * old one presented as now. One that cannot be looked at (a 403, a timeout) is
 * kept, after the ones known to be current. When every endpoint is old (the
 * chain itself has halted) none is left out.
 */

export type ProbeKind = "lcd" | "rpc";

interface Head {
  height: number;
  /** Block time, ms since the epoch. */
  time: number;
}

interface Probe {
  /** When it was last looked at. */
  at: number;
  head: Head | null;
  pending: Promise<void> | null;
}

const PROBE_EVERY_MS = 60_000;
const PROBE_TIMEOUT_MS = 4000;
/** How long the first request for a chain waits for a first look. */
const FIRST_LOOK_MS = 2000;
export const BEHIND_BLOCKS = 100;
export const OLD_MS = 10 * 60_000;

const KEY = Symbol.for("gata.endpointHeads");
const probes: Map<string, Probe> =
  ((globalThis as Record<symbol, unknown>)[KEY] as Map<string, Probe>) ??
  ((globalThis as Record<symbol, unknown>)[KEY] = new Map());

/** The newest block an endpoint reports: Cosmos REST, or Tendermint/TM2 RPC (gno.land). */
async function look(kind: ProbeKind, endpoint: string): Promise<Head | null> {
  const base = endpoint.replace(/\/+$/, "");
  const url = kind === "lcd" ? `${base}/cosmos/base/tendermint/v1beta1/blocks/latest` : `${base}/status`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      block?: { header?: { height?: string; time?: string } };
      result?: { sync_info?: { latest_block_height?: string; latest_block_time?: string } };
    };
    const height = Number(kind === "lcd" ? body.block?.header?.height : body.result?.sync_info?.latest_block_height);
    const time = Date.parse(
      (kind === "lcd" ? body.block?.header?.time : body.result?.sync_info?.latest_block_time) ?? ""
    );
    return Number.isFinite(height) && Number.isFinite(time) ? { height, time } : null;
  } catch {
    return null;
  }
}

function refresh(kind: ProbeKind, endpoint: string): Promise<void> {
  const current = probes.get(endpoint);
  if (current?.pending) return current.pending;
  const entry: Probe = current ?? { at: 0, head: null, pending: null };
  entry.pending = look(kind, endpoint).then((head) => {
    entry.head = head;
    entry.at = Date.now();
    entry.pending = null;
  });
  probes.set(endpoint, entry);
  return entry.pending;
}

/** Whether each endpoint is current, stale or unknown, from what was last seen. Exported for tests. */
export function classify(
  endpoints: string[],
  heads: Map<string, Head | null>,
  now: number
): Map<string, "current" | "stale" | "unknown"> {
  const known = endpoints.flatMap((e) => {
    const h = heads.get(e);
    return h ? [h] : [];
  });
  const top = known.reduce((m, h) => Math.max(m, h.height), 0);
  const anyRecent = known.some((h) => now - h.time <= OLD_MS);
  const out = new Map<string, "current" | "stale" | "unknown">();
  for (const e of endpoints) {
    const h = heads.get(e);
    if (!h) out.set(e, "unknown");
    else if (h.height < top - BEHIND_BLOCKS || (anyRecent && now - h.time > OLD_MS)) out.set(e, "stale");
    else out.set(e, "current");
  }
  return out;
}

/**
 * The endpoints to try, current ones first, stale ones left out. Looks are
 * refreshed in the background; only a chain's very first request waits, at
 * most FIRST_LOOK_MS, for one.
 */
export async function freshEndpoints(
  kind: ProbeKind,
  primaries: string[],
  fallbacks: string[] = []
): Promise<{ primaries: string[]; fallbacks: string[] }> {
  const all = [...new Set([...primaries, ...fallbacks])];
  const now = Date.now();
  const firstLooks: Promise<void>[] = [];
  for (const e of all) {
    const p = probes.get(e);
    if (!p || now - p.at > PROBE_EVERY_MS) {
      const looking = refresh(kind, e);
      if (!p || p.at === 0) firstLooks.push(looking);
    }
  }
  if (firstLooks.length > 0) {
    await Promise.race([Promise.all(firstLooks), new Promise((r) => setTimeout(r, FIRST_LOOK_MS))]);
  }
  const state = classify(
    all,
    new Map(all.map((e) => [e, probes.get(e)?.head ?? null])),
    Date.now()
  );
  const order = (list: string[]) => [
    ...list.filter((e) => state.get(e) === "current"),
    ...list.filter((e) => state.get(e) === "unknown"),
  ];
  return { primaries: order(primaries), fallbacks: order(fallbacks) };
}
