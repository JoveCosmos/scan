import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import {
  recentFacts,
  toSummary,
  type BlockResponse,
  type BlockSummary,
} from "@/lib/block-facts";
import { isNumericId } from "@/lib/input";
import { proposerIndex } from "@/lib/uptime";
import { getValidatorsCached } from "@/lib/validators";

export type { BlockSummary } from "@/lib/block-facts";

export const RECENT_BLOCK_COUNT = 30;

/** A block summary with its proposer resolved to a validator, where possible. */
export interface NamedBlock extends BlockSummary {
  proposerMoniker: string | null;
  proposerOperator: string | null;
}

/**
 * Name the proposers of a page of blocks.
 *
 * A header carries its proposer as a raw consensus address. This builds the
 * lookup once from a set the caller already holds and applies it to the whole
 * page. A proposer that cannot be resolved keeps its raw address
 * rather than going blank.
 */
export function nameProposers(
  blocks: BlockSummary[],
  validators: {
    moniker: string;
    operatorAddress: string;
    consensusPubkey: string | null;
  }[],
  bech32Prefix: string
): NamedBlock[] {
  const index = proposerIndex(validators, bech32Prefix);
  return blocks.map((block) => {
    const hit = index.get(block.proposer);
    return {
      ...block,
      proposerMoniker: hit?.moniker ?? null,
      proposerOperator: hit?.operator ?? null,
    };
  });
}

export interface BlockDetail extends BlockSummary {
  chainId: string | null;
  appHash: string | null;
  dataHash: string | null;
  validatorsHash: string | null;
  lastCommitHash: string | null;
  signatureCount: number | null;
  rawTxs: string[];
  /** Resolved from the consensus address when the validator set is reachable. */
  proposerMoniker: string | null;
  proposerOperator: string | null;
}

/**
 * Name a block's proposer from the shared, cached validator set. The header
 * carries a raw consensus address, which is what proposerIndex keys on.
 */
async function resolveProposer(
  chain: ChainConfig,
  proposerAddressB64: string
): Promise<{ moniker: string | null; operator: string | null }> {
  try {
    const hit = proposerIndex(await getValidatorsCached(chain), chain.bech32Prefix).get(
      proposerAddressB64
    );
    return { moniker: hit?.moniker ?? null, operator: hit?.operator ?? null };
  } catch {
    return { moniker: null, operator: null };
  }
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
  const proposer = await resolveProposer(chain, header.proposer_address);

  return {
    ...summary,
    chainId: header.chain_id ?? null,
    appHash: header.app_hash ?? null,
    dataHash: header.data_hash ?? null,
    validatorsHash: header.validators_hash ?? null,
    lastCommitHash: header.last_commit_hash ?? null,
    signatureCount: res.block.last_commit?.signatures?.length ?? null,
    rawTxs: res.block.data.txs ?? [],
    proposerMoniker: proposer.moniker,
    proposerOperator: proposer.operator,
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
