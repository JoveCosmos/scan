import type { ChainConfig } from "@/lib/chains";
import type { ChainOverview } from "@/lib/overview";
import { getChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import { getRecentBlocks, getBlockDetail } from "@/lib/blocks";
import { txsAtHeight } from "@/lib/txs";
import type { TxSummary, TxDetail } from "@/lib/txs";
import { getRecentTxs, getTx } from "@/lib/txs";
import type { ValidatorSummary } from "@/lib/validators";
import { getValidators } from "@/lib/validators";
import type { AccountView } from "@/lib/accounts";
import { getCosmosAccount, getCosmosAccountTxs } from "@/lib/accounts";
import type { ProposalSummary, GovParams, ProposalVotes } from "@/lib/proposals";
import {
  getProposals,
  getProposal,
  getGovParams,
  getProposalVotes,
} from "@/lib/proposals";
import {
  gnoOverview,
  gnoRecentBlocks,
  gnoRecentTxs,
  gnoTx,
  gnoValidators,
  gnoBlockDetail,
  gnoBlockTxs,
  gnoAccount,
  gnoRegisteredCount,
  gnoAccountTxs,
} from "@/lib/gno";

/**
 * Cosmos can return a full detail record; gno's indexing API exposes no raw log
 * or signer list, so those fields are optional across the adapter boundary.
 */
export type TxView = TxSummary &
  Partial<Pick<TxDetail, "rawLog" | "signers" | "timeoutHeight">>;

/**
 * Union of what either chain kind can say about a single block. Cosmos supplies
 * the Tendermint header hashes and a signature count; gno supplies gas totals
 * and fees. Everything beyond the common summary is optional, and the page
 * renders only the rows it actually has.
 */
export type BlockView = BlockSummary & {
  chainId?: string | null;
  appHash?: string | null;
  dataHash?: string | null;
  validatorsHash?: string | null;
  signatureCount?: number | null;
  proposerMoniker?: string | null;
  proposerOperator?: string | null;
  /** gno exposes a proposer label without a linkable validator profile. */
  proposerLabel?: string | null;
  gasUsed?: string | null;
  gasWanted?: string | null;
  totalFees?: string | null;
  rawTxs?: string[];
};

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
  /**
   * Voting power is assigned rather than staked, so power-share metrics measure
   * consensus weight, not economic stake.
   */
  stakeWeighted: boolean;
  /** Chain has a validator registry separate from the active set. */
  registry: boolean;
  /** Chain has an on-chain governance module. */
  governance: boolean;
}

export interface ChainAdapter {
  capabilities: ChainCapabilities;
  getOverview(): Promise<ChainOverview>;
  getRecentBlocks(count?: number): Promise<BlockSummary[]>;
  getBlockDetail(height: string): Promise<BlockView | null>;
  /** Transactions contained in one block. */
  getBlockTxs(block: BlockView): Promise<TxSummary[]>;
  getRecentTxs(): Promise<RecentTxs>;
  getTx(hash: string): Promise<TxView | null>;
  getValidators(): Promise<ValidatorSummary[]>;
  /** Size of the validator registry, where one exists. */
  getRegisteredCount(): Promise<number | null>;
  getAccount(address: string): Promise<AccountView>;
  /** Transactions this address sent or received. */
  getAccountTxs(
    address: string
  ): Promise<{ txs: TxSummary[]; total: number | null; failed: boolean }>;
  getProposals(
    limit?: number
  ): Promise<{ proposals: ProposalSummary[]; total: number | null }>;
  getProposal(id: string): Promise<ProposalSummary | null>;
  getProposalVotes(id: string): Promise<ProposalVotes>;
  getGovParams(): Promise<GovParams | null>;
}

export function getAdapter(chain: ChainConfig): ChainAdapter {
  if (chain.kind === "gno") {
    return {
      capabilities: {
        staking: false,
        gas: false,
        hexHashes: false,
        stakeWeighted: false,
        registry: true,
        // gno.land governance lives in realms (GovDAO), not a gov module.
        governance: false,
      },
      getOverview: () => gnoOverview(chain),
      getRecentBlocks: (count) => gnoRecentBlocks(chain, count),
      getBlockDetail: (height) => gnoBlockDetail(chain, height),
      getBlockTxs: (block) => gnoBlockTxs(chain, block.height),
      getRecentTxs: () => gnoRecentTxs(chain),
      getTx: (hash) => gnoTx(chain, hash),
      getValidators: () => gnoValidators(chain),
      getRegisteredCount: () => gnoRegisteredCount(chain),
      getAccount: (address) => gnoAccount(chain, address),
      getAccountTxs: (address) => gnoAccountTxs(chain, address),
      getProposals: async () => ({ proposals: [], total: null }),
      getProposal: async () => null,
      getProposalVotes: async () => ({
        votes: [],
        total: null,
        byOption: {},
        source: "state" as const,
        truncated: false,
        failed: false,
      }),
      getGovParams: async () => null,
    };
  }

  return {
    capabilities: {
      staking: true,
      gas: true,
      hexHashes: true,
      stakeWeighted: true,
      registry: false,
      governance: true,
    },
    getOverview: () => getChainOverview(chain),
    getRecentBlocks: (count) => getRecentBlocks(chain, count),
    getBlockDetail: (height) => getBlockDetail(chain, height),
    getBlockTxs: (block) =>
      txsAtHeight(chain, block.height, block.rawTxs ?? [], block.time),
    getRecentTxs: () => getRecentTxs(chain),
    getTx: (hash) => getTx(chain, hash),
    getValidators: () => getValidators(chain),
    getRegisteredCount: async () => null,
    getAccount: (address) => getCosmosAccount(chain, address),
    getAccountTxs: (address) => getCosmosAccountTxs(chain, address),
    getProposals: (limit) => getProposals(chain, limit),
    getProposal: (id) => getProposal(chain, id),
    getProposalVotes: (id) => getProposalVotes(chain, id),
    getGovParams: () => getGovParams(chain),
  };
}
