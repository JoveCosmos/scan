import { createHash } from "node:crypto";
import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";

/**
 * What the app needs from one Cosmos block, cached by height.
 *
 * A block never changes once committed, so every reader shares one copy: the
 * blocks feed, the signing bars on the validator list, the longer strip on a
 * validator's page and the 24h stake baseline all read the same heights. Before
 * this each fetched its own, so opening a validator re-read a hundred blocks
 * the list had fetched seconds earlier.
 *
 * Only the facts are kept, not the block: transactions can make a block large,
 * and a summary plus the signer list is all any of those readers use.
 */

export interface BlockResponse {
  block_id?: { hash: string };
  block: {
    header: {
      chain_id?: string;
      height: string;
      time: string;
      proposer_address: string;
      last_commit_hash?: string;
      data_hash?: string;
      validators_hash?: string;
      app_hash?: string;
      consensus_hash?: string;
    };
    data: { txs: string[] | null };
    last_commit?: {
      signatures?: { validator_address?: string; block_id_flag?: string }[];
    };
  };
}

export interface BlockSummary {
  height: string;
  time: string;
  txCount: number;
  proposer: string;
  hash: string | null;
}

export interface BlockFacts {
  summary: BlockSummary;
  /**
   * Base64 consensus addresses that signed the *previous* block — a block's
   * last_commit describes its parent. Absent votes are left out.
   */
  signers: string[];
  /** Hashes of the block's transactions, computed from the raw bytes. */
  txHashes: string[];
}

export function toSummary(res: BlockResponse): BlockSummary {
  return {
    height: res.block.header.height,
    time: res.block.header.time,
    txCount: res.block.data.txs?.length ?? 0,
    proposer: res.block.header.proposer_address,
    hash: res.block_id?.hash ?? null,
  };
}

function toFacts(res: BlockResponse): BlockFacts {
  const signers: string[] = [];
  for (const sig of res.block.last_commit?.signatures ?? []) {
    if (sig.block_id_flag === "BLOCK_ID_FLAG_ABSENT") continue;
    if (sig.validator_address) signers.push(sig.validator_address);
  }
  const txHashes = (res.block.data.txs ?? []).map((raw) =>
    createHash("sha256").update(Buffer.from(raw, "base64")).digest("hex").toUpperCase()
  );
  return { summary: toSummary(res), signers, txHashes };
}

/** Immutable, so kept for half an hour; the sweep in lib/cache drops old ones. */
const BLOCK_TTL = 30 * 60_000;

export function blockFacts(chain: ChainConfig, height: number | string): Promise<BlockFacts> {
  return cached(`blockfacts:${chain.chainId}:${height}`, BLOCK_TTL, async () =>
    toFacts(
      await fetchLcd<BlockResponse>(
        chain,
        `/cosmos/base/tendermint/v1beta1/blocks/${height}`,
        { cache: "no-store", timeoutMs: 8000 }
      )
    )
  );
}

/**
 * The head block. Cached for a second so the several readers on one page view
 * (and every viewer polling the feed) share a single request; the result is
 * also filed under its own height for the readers above.
 */
export function latestFacts(chain: ChainConfig): Promise<BlockFacts> {
  return cached(`blockfacts:${chain.chainId}:latest`, 1000, async () => {
    const facts = toFacts(
      await fetchLcd<BlockResponse>(chain, "/cosmos/base/tendermint/v1beta1/blocks/latest", {
        cache: "no-store",
      })
    );
    void cached(
      `blockfacts:${chain.chainId}:${facts.summary.height}`,
      BLOCK_TTL,
      async () => facts
    );
    return facts;
  });
}

/**
 * The last `count` blocks, newest first. Misses are dropped rather than
 * failing the list — a pruned node legitimately 404s older heights.
 */
export async function recentFacts(chain: ChainConfig, count: number): Promise<BlockFacts[]> {
  const head = await latestFacts(chain);
  const top = Number(head.summary.height);
  if (!Number.isFinite(top)) return [head];

  const heights = Array.from({ length: count - 1 }, (_, i) => top - (i + 1)).filter(
    (h) => h > 0
  );
  const settled = await Promise.allSettled(heights.map((h) => blockFacts(chain, h)));
  return [
    head,
    ...settled
      .filter((r): r is PromiseFulfilledResult<BlockFacts> => r.status === "fulfilled")
      .map((r) => r.value),
  ];
}
