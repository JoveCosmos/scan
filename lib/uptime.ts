import { createHash } from "node:crypto";
import { bech32 } from "bech32";
import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

export interface ValidatorUptime {
  /** Signed share of the chain's slashing window, 0–1. Null when unknown. */
  ratio: number | null;
  missed: number | null;
  /** Blocks actually counted — the window, or fewer for a young validator. */
  window: number | null;
  /** Most recent blocks, oldest first. true = signed. Empty when unavailable. */
  bars: boolean[];
  tombstoned: boolean;
  /**
   * When the validator's most recent jail ends (ISO), or null if never jailed.
   *
   * The slashing module keeps no jail *count* — only this one timestamp — so
   * "how many times" is not answerable from a node. A date in the past means
   * the validator has been jailed and is since released; a future date means it
   * is jailed right now.
   */
  jailedUntil: string | null;
}

export const RECENT_BAR_COUNT = 20;

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
 * A Tendermint consensus address is the first 20 bytes of sha256(ed25519 pubkey).
 * Blocks carry it base64-encoded in their signatures; the slashing module keys
 * on the same bytes bech32-encoded as `<prefix>valcons`.
 */
export function consensusIdsFromPubkey(
  pubkeyBase64: string,
  bech32Prefix: string
): { base64: string; valcons: string } | null {
  // Buffer.from(..., "base64") is lenient: it silently drops invalid characters
  // rather than throwing, so junk still yields bytes. Those bytes would hash to
  // a perfectly valid-looking address that matches no validator — worse than
  // admitting we cannot derive one. An ed25519 consensus key is exactly 32 bytes.
  const raw = Buffer.from(pubkeyBase64 ?? "", "base64");
  if (raw.length !== 32) return null;

  try {
    const digest = createHash("sha256").update(raw).digest().subarray(0, 20);
    return {
      base64: digest.toString("base64"),
      valcons: bech32.encode(`${bech32Prefix}valcons`, bech32.toWords(digest)),
    };
  } catch {
    return null;
  }
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
async function signingInfos(
  chain: ChainConfig
): Promise<{ byValcons: Map<string, SigningInfo>; window: number | null }> {
  const byValcons = new Map<string, SigningInfo>();
  let window: number | null = null;

  try {
    const params = await fetchLcd<{ params?: { signed_blocks_window?: string } }>(
      chain,
      "/cosmos/slashing/v1beta1/params",
      { cache: "no-store", timeoutMs: 10_000 }
    );
    const w = Number(params.params?.signed_blocks_window);
    if (Number.isFinite(w) && w > 0) window = w;
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

  return { byValcons, window };
}

interface CosmosBlock {
  block: {
    header: { height: string };
    last_commit?: {
      signatures?: { validator_address?: string; block_id_flag?: string }[];
    };
  };
}

/**
 * Who signed each of the last N blocks, keyed by base64 consensus address.
 *
 * A block's `last_commit` describes the *previous* block, which is why this is
 * read from the head backwards and reported oldest-first.
 */
async function recentSigners(
  chain: ChainConfig,
  count: number
): Promise<{ heights: string[]; signers: Set<string>[] }> {
  const empty = { heights: [], signers: [] };
  let head: number;

  try {
    const latest = await fetchLcd<CosmosBlock>(
      chain,
      "/cosmos/base/tendermint/v1beta1/blocks/latest",
      { cache: "no-store" }
    );
    head = Number(latest.block.header.height);
  } catch {
    return empty;
  }
  if (!Number.isFinite(head)) return empty;

  const heights = Array.from({ length: count }, (_, i) => head - i)
    .filter((h) => h > 0)
    .reverse();

  const blocks = await Promise.allSettled(
    heights.map((h) =>
      fetchLcd<CosmosBlock>(chain, `/cosmos/base/tendermint/v1beta1/blocks/${h}`, {
        cache: "no-store",
        timeoutMs: 8000,
      })
    )
  );

  const signers: Set<string>[] = [];
  const kept: string[] = [];

  blocks.forEach((result, i) => {
    if (result.status !== "fulfilled") return;
    const set = new Set<string>();
    for (const sig of result.value.block.last_commit?.signatures ?? []) {
      // An absent vote still occupies a slot, flagged as such.
      if (sig.block_id_flag === "BLOCK_ID_FLAG_ABSENT") continue;
      if (sig.validator_address) set.add(sig.validator_address);
    }
    signers.push(set);
    kept.push(String(heights[i]));
  });

  return { heights: kept, signers };
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
  validators: { operatorAddress: string; consensusPubkey: string | null }[]
): Promise<Map<string, ValidatorUptime>> {
  const [{ byValcons, window }, recent] = await Promise.all([
    signingInfos(chain),
    recentSigners(chain, RECENT_BAR_COUNT),
  ]);

  const out = new Map<string, ValidatorUptime>();

  for (const v of validators) {
    const entry = emptyUptime();
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
