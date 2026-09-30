import { createHash } from "node:crypto";
import { bech32 } from "bech32";
import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";
import { recentFacts } from "@/lib/block-facts";

export interface ValidatorUptime {
  /** Signed share of the chain's slashing window, 0–1. Null when unknown. */
  ratio: number | null;
  missed: number | null;
  /** Blocks actually counted - the window, or fewer for a young validator. */
  window: number | null;
  /** Most recent blocks, oldest first. true = signed. Empty when unavailable. */
  bars: boolean[];
  /** Height each bar describes, aligned with `bars`. Absent where unknown. */
  barHeights?: number[];
  /**
   * The chain's min_signed_per_window, 0–1: below it the validator is jailed.
   * Absent where the chain has no slashing module.
   */
  minSigned?: number | null;
  tombstoned: boolean;
  /**
   * When the validator's most recent jail ends (ISO), or null if never jailed.
   *
   * The slashing module keeps no jail *count* - only this one timestamp - so
   * "how many times" is not answerable from a node. A date in the past means
   * the validator has been jailed and is since released; a future date means it
   * is jailed right now.
   */
  jailedUntil: string | null;
}

export const RECENT_BAR_COUNT = 20;

/**
 * Bars on a single validator's page. Larger than the list's because the cost is
 * one block read per bar *for the whole chain*, not per validator - the list
 * pays it once for 100 rows, and a detail page can afford a longer history.
 */
export const DETAIL_BAR_COUNT = 100;

/**
 * The slashing module writes the zero time for a validator that has never been
 * jailed. Different chains serialise that as 1970-01-01, 0001-01-01 or an empty
 * string, so anything at or before 1971 counts as "never" rather than as a jail
 * that ended 55 years ago.
 */
function neverJailed(jailedUntil: string | undefined): boolean {
  if (!jailedUntil) return true;
  const t = new Date(jailedUntil).getTime();
  if (!Number.isFinite(t)) return true;
  return t <= Date.UTC(1971, 0, 1);
}

export function emptyUptime(): ValidatorUptime {
  return {
    ratio: null,
    missed: null,
    window: null,
    bars: [],
    tombstoned: false,
    jailedUntil: null,
  };
}

/**
 * Blocks a validator can still miss before it is jailed:
 * window × (1 − min_signed_per_window) − missed, floored at zero.
 * Null when any input is unknown.
 */
export function missBudget(
  window: number | null,
  minSigned: number | null | undefined,
  missed: number | null
): number | null {
  if (window === null || missed === null || minSigned === null || minSigned === undefined) {
    return null;
  }
  if (!Number.isFinite(window) || !Number.isFinite(minSigned) || window <= 0) return null;
  return Math.max(0, Math.floor(window * (1 - minSigned)) - missed);
}

/** Longest run of consecutive missed blocks in a bar strip. */
export function longestMissStreak(bars: boolean[]): number {
  let best = 0;
  let run = 0;
  for (const signed of bars) {
    run = signed ? 0 : run + 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Whether a validator is jailed right now, from the slashing module's
 * jailed_until. While jailed its signing window is reset and stops counting,
 * so a percentage read from it would be a clean record it did not earn.
 */
export function jailedNow(uptime: ValidatorUptime, jailedFlag: boolean, now = Date.now()): boolean {
  if (jailedFlag) return true;
  if (!uptime.jailedUntil) return false;
  const t = Date.parse(uptime.jailedUntil);
  return Number.isFinite(t) && t > now;
}

/**
 * A Tendermint consensus address is the first 20 bytes of sha256(ed25519 pubkey).
 * Blocks carry it base64-encoded in their signatures; the slashing module keys
 * on the same bytes bech32-encoded as `<prefix>valcons`.
 */
export function consensusIdsFromPubkey(
  pubkeyBase64: string,
  bech32Prefix: string
): { base64: string; hex: string; valcons: string } | null {
  // Buffer.from(..., "base64") is lenient: it silently drops invalid characters
  // rather than throwing, so junk still yields bytes. Those bytes would hash to
  // a perfectly valid-looking address that matches no validator - worse than
  // admitting we cannot derive one. An ed25519 consensus key is exactly 32 bytes.
  const raw = Buffer.from(pubkeyBase64 ?? "", "base64");
  if (raw.length !== 32) return null;

  try {
    const digest = createHash("sha256").update(raw).digest().subarray(0, 20);
    return {
      base64: digest.toString("base64"),
      // Uppercase hex is how CometBFT's own RPC renders a proposer address in a
      // block header, which is the form the indexer stores verbatim. The LCD
      // renders the same bytes as base64, hence keeping both.
      hex: digest.toString("hex").toUpperCase(),
      valcons: bech32.encode(`${bech32Prefix}valcons`, bech32.toWords(digest)),
    };
  } catch {
    return null;
  }
}

/**
 * Consensus address → validator, for naming block proposers in a list.
 *
 * A block header carries its proposer as a raw consensus address. Resolving one
 * at a time costs a validator-set read per block, so views that show many blocks
 * build this once from a set they already hold and look every proposer up
 * locally. Both encodings are keyed: the LCD renders a proposer address base64,
 * CometBFT's own RPC renders the same bytes as uppercase hex.
 *
 * Takes the validator list rather than fetching it, so this stays free of the
 * adapter and callers keep whatever caching they already have.
 */
export function proposerIndex(
  validators: {
    moniker: string;
    operatorAddress: string;
    consensusPubkey: string | null;
  }[],
  bech32Prefix: string
): Map<string, { moniker: string; operator: string }> {
  const index = new Map<string, { moniker: string; operator: string }>();
  for (const v of validators) {
    if (!v.consensusPubkey) continue;
    const ids = consensusIdsFromPubkey(v.consensusPubkey, bech32Prefix);
    if (!ids) continue;
    const entry = { moniker: v.moniker, operator: v.operatorAddress };
    index.set(ids.base64, entry);
    index.set(ids.hex, entry);
  }
  return index;
}

interface SigningInfo {
  address: string;
  index_offset?: string;
  missed_blocks_counter?: string;
  tombstoned?: boolean;
  /** Epoch (1970) for a validator that has never been jailed. */
  jailed_until?: string;
}

/** Slashing-window misses, keyed by valcons. One paged read for the whole set. */
function signingInfos(
  chain: ChainConfig
): Promise<{
  byValcons: Map<string, SigningInfo>;
  window: number | null;
  minSigned: number | null;
}> {
  // Misses move by at most one per block, so 15s fresh and a minute of
  // stale-while-revalidate costs nothing a reader could notice.
  return cached(`signinginfos:${chain.chainId}`, 15_000, () => readSigningInfos(chain), {
    staleMs: 120_000,
  });
}

async function readSigningInfos(chain: ChainConfig): Promise<{
  byValcons: Map<string, SigningInfo>;
  window: number | null;
  minSigned: number | null;
}> {
  const byValcons = new Map<string, SigningInfo>();
  let window: number | null = null;
  let minSigned: number | null = null;

  try {
    const params = await fetchLcd<{
      params?: { signed_blocks_window?: string; min_signed_per_window?: string };
    }>(chain, "/cosmos/slashing/v1beta1/params", { cache: "no-store", timeoutMs: 10_000 });
    const w = Number(params.params?.signed_blocks_window);
    if (Number.isFinite(w) && w > 0) window = w;
    const m = Number(params.params?.min_signed_per_window);
    if (Number.isFinite(m) && m >= 0 && m <= 1) minSigned = m;
  } catch {
    // Uptime percentages just stay null.
  }

  let nextKey: string | null = null;
  for (let page = 0; page < 6; page++) {
    try {
      const res: {
        info?: SigningInfo[];
        pagination?: { next_key: string | null };
      } = await fetchLcd(chain, "/cosmos/slashing/v1beta1/signing_infos", {
        cache: "no-store",
        timeoutMs: 12_000,
        searchParams: {
          "pagination.limit": 500,
          ...(nextKey ? { "pagination.key": nextKey } : {}),
        },
      });
      for (const info of res.info ?? []) byValcons.set(info.address, info);
      nextKey = res.pagination?.next_key ?? null;
      if (!nextKey) break;
    } catch {
      break;
    }
  }

  return { byValcons, window, minSigned };
}

/**
 * Who signed each of the last N blocks, keyed by base64 consensus address.
 *
 * A block's `last_commit` describes the *previous* block, which is why this is
 * read from the head backwards and reported oldest-first. Heights come from the
 * shared block cache, so the list's strip and a validator page's longer one
 * read each block once between them.
 */
async function recentSigners(
  chain: ChainConfig,
  count: number
): Promise<{ heights: string[]; signers: Set<string>[] }> {
  let facts;
  try {
    facts = await recentFacts(chain, count);
  } catch {
    return { heights: [], signers: [] };
  }
  const oldestFirst = [...facts].reverse();
  return {
    heights: oldestFirst.map((f) => f.summary.height),
    signers: oldestFirst.map((f) => new Set(f.signers)),
  };
}

/**
 * Uptime for every validator, keyed by operator address.
 *
 * Two independent sources: the slashing module for the long-window percentage
 * and missed count, and recent blocks for the bar strip. Either may be missing
 * without failing the other.
 */
export async function getCosmosUptime(
  chain: ChainConfig,
  validators: { operatorAddress: string; consensusPubkey: string | null }[],
  barCount = RECENT_BAR_COUNT
): Promise<Map<string, ValidatorUptime>> {
  const [{ byValcons, window, minSigned }, recent] = await Promise.all([
    signingInfos(chain),
    recentSigners(chain, barCount),
  ]);

  const out = new Map<string, ValidatorUptime>();

  for (const v of validators) {
    const entry = emptyUptime();
    entry.minSigned = minSigned;
    // A block's last_commit records who signed the block before it.
    entry.barHeights = recent.heights.map((h) => Number(h) - 1);
    const ids = v.consensusPubkey
      ? consensusIdsFromPubkey(v.consensusPubkey, chain.bech32Prefix)
      : null;

    if (ids) {
      const info = byValcons.get(ids.valcons);
      if (info) {
        const missed = Number(info.missed_blocks_counter ?? 0);
        const seen = Number(info.index_offset ?? 0);
        // A validator younger than the window has only been measured over the
        // blocks it has actually been present for.
        const effective = window ? Math.min(window, seen || window) : null;
        entry.missed = Number.isFinite(missed) ? missed : null;
        entry.window = effective;
        entry.tombstoned = info.tombstoned ?? false;
        entry.jailedUntil = neverJailed(info.jailed_until)
          ? null
          : (info.jailed_until ?? null);
        if (effective && effective > 0 && entry.missed !== null) {
          entry.ratio = Math.max(0, Math.min(1, (effective - entry.missed) / effective));
        }
      }
      entry.bars = recent.signers.map((set) => set.has(ids.base64));
    }

    out.set(v.operatorAddress, entry);
  }

  return out;
}
