import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import {
  blockFacts,
  recentFacts,
  toSummary,
  type BlockResponse,
  type BlockSummary,
} from "@/lib/block-facts";
import { base64ToHex, truncateMiddle } from "@/lib/format";
import { isNumericId } from "@/lib/input";
import { consensusIdsFromPubkey, proposerIndex } from "@/lib/uptime";
import { getValidatorsCached } from "@/lib/validators";
import { absentAt, operatorsForHex } from "@/lib/indexer-validator";

export type { BlockSummary } from "@/lib/block-facts";

export const RECENT_BLOCK_COUNT = 30;

/** A block summary with its proposer resolved to a validator, where possible. */
export interface NamedBlock extends BlockSummary {
  proposerMoniker: string | null;
  proposerOperator: string | null;
}

interface NamedValidator {
  moniker: string;
  operatorAddress: string;
  consensusPubkey: string | null;
}

/**
 * Name the proposers of a page of blocks.
 *
 * A Cosmos header carries its proposer as a raw consensus address, matched
 * through the validators' consensus keys. gno has no consensus keys on the
 * set, so there the proposer is matched on the signing address the validator
 * is listed under, or on the name the gno feed already substituted for it.
 * A proposer that cannot be resolved keeps its raw value rather than going
 * blank.
 */
export function nameProposers(
  blocks: BlockSummary[],
  validators: NamedValidator[],
  bech32Prefix: string
): NamedBlock[] {
  const index = proposerIndex(validators, bech32Prefix);
  const byOperator = new Map(validators.map((v) => [v.operatorAddress, v]));
  const byMoniker = new Map(validators.map((v) => [v.moniker, v]));
  return blocks.map((block) => {
    // A feed may already have named its proposer (gno does, from its own
    // registry); a match here refines it, a miss never erases it.
    const given = block as BlockSummary & {
      proposerMoniker?: string | null;
      proposerOperator?: string | null;
    };
    const hit = index.get(block.proposer);
    if (hit) {
      return { ...block, proposerMoniker: hit.moniker, proposerOperator: hit.operator };
    }
    const direct = byOperator.get(block.proposer) ?? byMoniker.get(block.proposer);
    return {
      ...block,
      proposerMoniker: direct?.moniker ?? given.proposerMoniker ?? null,
      proposerOperator: direct?.operatorAddress ?? given.proposerOperator ?? null,
    };
  });
}

export interface AbsentValidator {
  moniker: string;
  operator: string;
}

export interface BlockDetail extends BlockSummary {
  chainId: string | null;
  appHash: string | null;
  dataHash: string | null;
  validatorsHash: string | null;
  lastCommitHash: string | null;
  /** Entries in the block's last commit, which describes the previous block. */
  signatureCount: number | null;
  /** Of those, the ones that actually signed (commit or nil vote). */
  signedCount: number | null;
  absentCount: number | null;
  /**
   * The absent validators by name, when the current set accounts for exactly
   * the absent entries. Null when it cannot (the set has changed since), so a
   * guess is never shown as a list.
   */
  absentValidators: AbsentValidator[] | null;
  rawTxs: string[];
  /** Resolved from the consensus address when the validator set is reachable. */
  proposerMoniker: string | null;
  proposerOperator: string | null;
  proposerValcons: string | null;
}

export async function getBlockDetail(
  chain: ChainConfig,
  height: string | number
): Promise<BlockDetail | null> {
  // Heights are interpolated into an LCD path. See lib/input.ts.
  if (!isNumericId(height)) return null;

  let res: BlockResponse;
  try {
    res = await fetchLcd<BlockResponse>(
      chain,
      `/cosmos/base/tendermint/v1beta1/blocks/${height}`,
      { cache: "no-store", timeoutMs: 10_000 }
    );
  } catch {
    return null;
  }

  const summary = toSummary(res);
  const header = res.block.header;
  const validators = await getValidatorsCached(chain).catch(() => []);
  const hit = proposerIndex(validators, chain.bech32Prefix).get(header.proposer_address);

  // Signing: ABSENT entries carry no address, so who was absent is found by
  // subtracting the signers from the set.
  const sigs = res.block.last_commit?.signatures ?? null;
  const signers = new Set<string>();
  let absentCount = 0;
  for (const sig of sigs ?? []) {
    if (sig.block_id_flag === "BLOCK_ID_FLAG_ABSENT") absentCount++;
    else if (sig.validator_address) signers.add(sig.validator_address);
  }
  let absentValidators: AbsentValidator[] | null = null;
  if (sigs) {
    const missing: AbsentValidator[] = [];
    for (const v of validators) {
      if (!v.consensusPubkey) continue;
      const ids = consensusIdsFromPubkey(v.consensusPubkey, chain.bech32Prefix);
      if (ids && !signers.has(ids.base64)) {
        missing.push({ moniker: v.moniker, operator: v.operatorAddress });
      }
    }
    absentValidators = missing.length === absentCount ? missing : null;
  }

  // The set has changed since: ask the index which keys missed that commit.
  // Block N's last commit is for N-1, which is the height missed_signature
  // records.
  if (sigs && absentCount > 0 && absentValidators === null) {
    const hexes = await absentAt(chain.chainId, Number(summary.height) - 1).catch(() => null);
    if (hexes && hexes.length === absentCount) {
      const byHex = new Map<string, { moniker: string; operator: string }>();
      for (const v of validators) {
        const ids = v.consensusPubkey
          ? consensusIdsFromPubkey(v.consensusPubkey, chain.bech32Prefix)
          : null;
        if (ids) byHex.set(ids.hex.toUpperCase(), { moniker: v.moniker, operator: v.operatorAddress });
      }
      const unknown = hexes.filter((h) => !byHex.has(h));
      const keyed = await operatorsForHex(chain.chainId, unknown);
      const resolved = hexes.map((h) => {
        const hit = byHex.get(h);
        if (hit) return hit;
        const operator = keyed.get(h);
        return operator ? { moniker: truncateMiddle(operator, 12, 6), operator } : null;
      });
      if (resolved.every((r) => r !== null)) absentValidators = resolved as AbsentValidator[];
    }
  }

  let proposerValcons: string | null = null;
  const proposerOp = hit?.operator ?? null;
  const proposerV = proposerOp ? validators.find((v) => v.operatorAddress === proposerOp) : null;
  if (proposerV?.consensusPubkey) {
    proposerValcons =
      consensusIdsFromPubkey(proposerV.consensusPubkey, chain.bech32Prefix)?.valcons ?? null;
  }

  return {
    ...summary,
    chainId: header.chain_id ?? null,
    appHash: base64ToHex(header.app_hash ?? null),
    dataHash: base64ToHex(header.data_hash ?? null),
    validatorsHash: base64ToHex(header.validators_hash ?? null),
    lastCommitHash: base64ToHex(header.last_commit_hash ?? null),
    signatureCount: sigs ? sigs.length : null,
    signedCount: sigs ? sigs.length - absentCount : null,
    absentCount: sigs ? absentCount : null,
    absentValidators,
    rawTxs: res.block.data.txs ?? [],
    proposerMoniker: hit?.moniker ?? null,
    proposerOperator: proposerOp,
    proposerValcons,
  };
}

/**
 * The Cosmos REST API exposes no "list blocks" endpoint, so we read the head and
 * fan out over the preceding heights. Individual misses are dropped rather than
 * failing the list — pruned nodes legitimately return 404 for older heights.
 */
export async function getRecentBlocks(
  chain: ChainConfig,
  count = RECENT_BLOCK_COUNT
): Promise<BlockSummary[]> {
  return (await recentFacts(chain, count)).map((f) => f.summary);
}

/**
 * The `count` blocks below `before`, newest first — the "Older" pages of the
 * blocks list. Committed blocks never change, so these come from the shared
 * block cache. A pruned height is dropped rather than failing the page.
 */
export async function getBlocksBefore(
  chain: ChainConfig,
  before: number,
  count = RECENT_BLOCK_COUNT
): Promise<BlockSummary[]> {
  const heights = Array.from({ length: count }, (_, i) => before - 1 - i).filter((h) => h > 0);
  const settled = await Promise.allSettled(heights.map((h) => blockFacts(chain, h)));
  return settled
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof blockFacts>>> => r.status === "fulfilled")
    .map((r) => r.value.summary);
}
