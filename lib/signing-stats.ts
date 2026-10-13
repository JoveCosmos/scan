/**
 * Pure arithmetic behind the indexed validator pages: runs of missed blocks,
 * signing reliability, jail-to-unjail downtime, recast votes and net stake flow.
 *
 * Kept free of I/O so the numbers the pages print can be tested directly; the
 * reads in lib/indexer-validator.ts only fetch rows and hand them here.
 */

export interface MissRun {
  /** First missed height of the run. */
  from: number;
  /** Last missed height of the run. */
  to: number;
  length: number;
}

/**
 * Consecutive missed heights grouped into runs, newest first. Heights may
 * arrive in any order and may repeat.
 */
export function missRuns(heights: readonly number[]): MissRun[] {
  const sorted = [...new Set(heights)].sort((a, b) => a - b);
  const runs: MissRun[] = [];
  for (const h of sorted) {
    const last = runs[runs.length - 1];
    if (last && h === last.to + 1) {
      last.to = h;
      last.length++;
    } else {
      runs.push({ from: h, to: h, length: 1 });
    }
  }
  return runs.reverse();
}

/** The longest run, the newest of equals; null when nothing was missed. */
export function longestRun(runs: readonly MissRun[]): MissRun | null {
  let best: MissRun | null = null;
  for (const r of runs) {
    if (!best || r.length > best.length || (r.length === best.length && r.to > best.to)) best = r;
  }
  return best;
}

/**
 * Share of blocks signed. Null when the window is empty or the counts are
 * inconsistent, so a page never prints a ratio it cannot stand behind.
 */
/**
 * Blocks in [from, to] the validator spent in the active set, from its voting
 * power changes (oldest first; power 0 = out of the set). Before its first
 * change it held no power. The index records misses only for slots a
 * validator was given, so this, not every block in the window, is the
 * denominator: time out of the set must not count as signed.
 */
export function activeBlocks(
  changes: { height: number; power: bigint }[],
  from: number,
  to: number
): number {
  if (to < from) return 0;
  let total = 0;
  for (let i = 0; i < changes.length; i++) {
    if (changes[i].power <= BigInt(0)) continue;
    const start = Math.max(changes[i].height, from);
    const end = Math.min(i + 1 < changes.length ? changes[i + 1].height - 1 : to, to);
    if (end >= start) total += end - start + 1;
  }
  return total;
}

export function reliability(blocks: number, missed: number): number | null {
  if (!Number.isFinite(blocks) || !Number.isFinite(missed)) return null;
  if (blocks <= 0 || missed < 0 || missed > blocks) return null;
  return 1 - missed / blocks;
}

/**
 * One slot per UTC day, oldest first, ending today; days with no misses are
 * zero rather than absent, so a bar chart drawn from it has no holes.
 */
export function dailySeries(
  rows: readonly { day: string; missed: number }[],
  days: number,
  today: Date = new Date()
): { day: string; missed: number }[] {
  const byDay = new Map(rows.map((r) => [r.day, r.missed]));
  const out: { day: string; missed: number }[] = [];
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, missed: byDay.get(day) ?? 0 });
  }
  return out;
}

export interface JailEventLike {
  kind: string;
  height: number;
  time: string;
}

export interface JailSpell {
  jailedAt: JailEventLike;
  /** The first unjail after the jailing; null while still jailed. */
  unjailedAt: JailEventLike | null;
  /** Milliseconds between the two, when both are known. */
  downtimeMs: number | null;
}

/**
 * Each jailing paired with the unjail that ended it: the first unjail above
 * its height and below the next jailing. Newest first.
 */
export function jailSpells(events: readonly JailEventLike[]): JailSpell[] {
  const ordered = [...events].sort((a, b) => a.height - b.height);
  const spells: JailSpell[] = [];
  let open: JailSpell | null = null;
  for (const e of ordered) {
    if (e.kind === "jailed") {
      if (open) spells.push(open);
      open = { jailedAt: e, unjailedAt: null, downtimeMs: null };
    } else if (e.kind === "unjailed" && open) {
      const ms = Date.parse(e.time) - Date.parse(open.jailedAt.time);
      open.unjailedAt = e;
      open.downtimeMs = Number.isFinite(ms) && ms >= 0 ? ms : null;
      spells.push(open);
      open = null;
    }
  }
  if (open) spells.push(open);
  return spells.reverse();
}

/** "3d 4h", "5h 12m", "42m" - a downtime at a glance. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "-";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${min}m`;
  return `${min}m`;
}

export interface CastVote {
  voter: string;
  proposalId: number;
  option: string;
  height: number;
  time: string;
  txHash: string;
}

/**
 * The options a voter chose before their final vote, oldest first, keyed by
 * `${proposalId}:${voter}`. Voters who voted once are absent. Casting the same
 * option twice is not a change, so consecutive duplicates collapse.
 */
export function earlierVotes(casts: readonly CastVote[]): Map<string, string[]> {
  const byKey = new Map<string, CastVote[]>();
  for (const c of casts) {
    const key = `${c.proposalId}:${c.voter}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }
  const out = new Map<string, string[]>();
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.height - b.height || a.time.localeCompare(b.time));
    const options: string[] = [];
    for (const c of list) {
      if (options[options.length - 1] !== c.option) options.push(c.option);
    }
    if (options.length > 1) out.set(key, options.slice(0, -1));
  }
  return out;
}

export interface StakeEventLike {
  kind: string;
  validator: string | null;
  validatorDst: string | null;
  amount: string | null;
  time: string;
}

/**
 * Net stake moved to (positive) or from (negative) a validator since a
 * cutoff, in base units. Completions and edits move nothing; a redelegation
 * counts against its source and for its destination.
 */
export function netStakeFlow(
  events: readonly StakeEventLike[],
  operator: string,
  sinceMs: number
): bigint {
  let net = BigInt(0);
  for (const e of events) {
    if (!e.amount || Date.parse(e.time) < sinceMs) continue;
    let amount: bigint;
    try {
      amount = BigInt(e.amount);
    } catch {
      continue;
    }
    switch (e.kind) {
      case "delegate":
      case "cancel_unbonding":
      case "create_validator":
        if (e.validator === operator) net += amount;
        break;
      case "undelegate":
        if (e.validator === operator) net -= amount;
        break;
      case "redelegate":
        if (e.validator === operator) net -= amount;
        if (e.validatorDst === operator) net += amount;
        break;
    }
  }
  return net;
}
