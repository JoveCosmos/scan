import type { ChainConfig } from "@/lib/chains";
import type { ChainOverview } from "@/lib/overview";
import { getChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import { getRecentBlocks } from "@/lib/blocks";
import type { TxSummary, TxDetail } from "@/lib/txs";
import { getRecentTxs, getTx } from "@/lib/txs";
import type { ValidatorSummary } from "@/lib/validators";
import { getValidators } from "@/lib/validators";
import {
  gnoOverview,
  gnoRecentBlocks,
  gnoRecentTxs,
  gnoTx,
  gnoValidators,
} from "@/lib/gno";

/**
 * Cosmos can return a full detail record; gno's indexing API exposes no raw log
 * or signer list, so those fields are optional across the adapter boundary.
 */
export type TxView = TxSummary &
  Partial<Pick<TxDetail, "rawLog" | "signers" | "timeoutHeight">>;

export interface RecentTxs {
  txs: TxSummary[];
  scannedBlocks: number;
  headHeight: string | null;
}

/**
 * Capabilities differ per chain kind, so the UI can hide columns that would
 * otherwise render as meaningless zeros (gno.land has no staking module).
 */
export interface ChainCapabilities {
  staking: boolean;
  gas: boolean;
  /** Whether tx hashes are hex (Cosmos) or base64 (gno) — affects URL encoding. */
  hexHashes: boolean;
}

export interface ChainAdapter {
  capabilities: ChainCapabilities;
  getOverview(): Promise<ChainOverview>;
  getRecentBlocks(count?: number): Promise<BlockSummary[]>;
  getRecentTxs(): Promise<RecentTxs>;
  getTx(hash: string): Promise<TxView | null>;
  getValidators(): Promise<ValidatorSummary[]>;
}

export function getAdapter(chain: ChainConfig): ChainAdapter {
  if (chain.kind === "gno") {
    return {
      capabilities: { staking: false, gas: false, hexHashes: false },
      getOverview: () => gnoOverview(chain),
      getRecentBlocks: (count) => gnoRecentBlocks(chain, count),
      getRecentTxs: () => gnoRecentTxs(chain),
      getTx: (hash) => gnoTx(chain, hash),
      getValidators: () => gnoValidators(chain),
    };
  }

  return {
    capabilities: { staking: true, gas: true, hexHashes: true },
    getOverview: () => getChainOverview(chain),
    getRecentBlocks: (count) => getRecentBlocks(chain, count),
    getRecentTxs: () => getRecentTxs(chain),
    getTx: (hash) => getTx(chain, hash),
    getValidators: () => getValidators(chain),
  };
}
