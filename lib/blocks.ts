import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

interface BlockResponse {
  block_id?: { hash: string };
  block: {
    header: {
      height: string;
      time: string;
      proposer_address: string;
    };
    data: { txs: string[] | null };
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
