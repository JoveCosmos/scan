import { createHash } from "node:crypto";
import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { isNumericId } from "@/lib/input";

interface BlockResponse {
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
    last_commit?: { signatures?: unknown[] };
  };
}

export interface BlockSummary {
  height: string;
  time: string;
  txCount: number;
  proposer: string;
  hash: string | null;
}

export const RECENT_BLOCK_COUNT = 15;

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

interface ValidatorSetEntry {
  operator_address: string;
  consensus_pubkey?: { key?: string };
  description?: { moniker?: string };
}

/**
 * A Tendermint consensus address is the first 20 bytes of sha256(ed25519 pubkey),
 * which is exactly what a block header carries as `proposer_address`. Hashing each
 * bonded validator's consensus key lets us name the proposer without a separate
 * bech32 decode or a historical validator-set lookup.
 */
export async function resolveProposer(
  chain: ChainConfig,
  proposerAddressB64: string
): Promise<{ moniker: string | null; operator: string | null }> {
  try {
    const res = await fetchLcd<{ validators: ValidatorSetEntry[] }>(
      chain,
      "/cosmos/staking/v1beta1/validators",
      {
        cache: "no-store",
        timeoutMs: 10_000,
        searchParams: {
          status: "BOND_STATUS_BONDED",
          "pagination.limit": 500,
        },
      }
    );

    const match = res.validators.find((v) => {
      const key = v.consensus_pubkey?.key;
      if (!key) return false;
      const consAddr = createHash("sha256")
        .update(Buffer.from(key, "base64"))
        .digest()
        .subarray(0, 20)
        .toString("base64");
      return consAddr === proposerAddressB64;
    });

    return {
      moniker: match?.description?.moniker ?? null,
      operator: match?.operator_address ?? null,
    };
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

function toSummary(res: BlockResponse): BlockSummary {
  return {
    height: res.block.header.height,
    time: res.block.header.time,
    txCount: res.block.data.txs?.length ?? 0,
    proposer: res.block.header.proposer_address,
    hash: res.block_id?.hash ?? null,
  };
}

export async function getBlock(
  chain: ChainConfig,
  height: string | number
): Promise<BlockSummary> {
  const res = await fetchLcd<BlockResponse>(
    chain,
    `/cosmos/base/tendermint/v1beta1/blocks/${height}`,
    { cache: "no-store" }
  );
  return toSummary(res);
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
  const latest = await fetchLcd<BlockResponse>(
    chain,
    "/cosmos/base/tendermint/v1beta1/blocks/latest",
    { cache: "no-store" }
  );

  const head = Number(latest.block.header.height);
  if (!Number.isFinite(head)) return [toSummary(latest)];

  const previous = Array.from({ length: count - 1 }, (_, i) => head - (i + 1)).filter(
    (h) => h > 0
  );

  const settled = await Promise.allSettled(
    previous.map((height) => getBlock(chain, height))
  );

  return [
    toSummary(latest),
    ...settled
      .filter(
        (r): r is PromiseFulfilledResult<BlockSummary> => r.status === "fulfilled"
      )
      .map((r) => r.value),
  ];
}
