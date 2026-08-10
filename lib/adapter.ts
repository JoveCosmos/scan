import type { ChainConfig } from "@/lib/chains";
import type { ChainOverview } from "@/lib/overview";
import { getChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import { getRecentBlocks, getBlockDetail } from "@/lib/blocks";
import { txsAtHeight } from "@/lib/txs";
import type { TxSummary, TxDetail } from "@/lib/txs";
import { getRecentTxs, getTx } from "@/lib/txs";
import type { ValidatorSummary } from "@/lib/validators";
import { getValidators, getValidatorDelegators } from "@/lib/validators";
import type { Delegator } from "@/lib/validators";
import type { ValidatorUptime } from "@/lib/uptime";
import type { StakeDelta } from "@/lib/stake-delta";
import { getStakeDeltas } from "@/lib/stake-delta";
import { getCosmosUptime } from "@/lib/uptime";
import { cached } from "@/lib/cache";
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
  gnoUptime,
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
  /** Uptime comes from a slashing window, not just recent blocks. */
  slashingWindow: boolean;
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
  /** Largest delegators to one validator. */
  getDelegators(
    operatorAddress: string
  ): Promise<{
    delegators: Delegator[];
    total: number | null;
    /** True when the delegation read hit its page cap, so ranking may be partial. */
    truncated: boolean;
    failed: boolean;
  }>;
  /** Signing history keyed by the same id the validator list uses. */
  getUptime(
    validators: { operatorAddress: string; consensusPubkey: string | null }[]
  ): Promise<Map<string, ValidatorUptime>>;
  /** 24h change in each validator's bonded stake. Empty when the endpoints
   *  cannot serve historical state. */
  getStakeDeltas(
    validators: { operatorAddress: string; tokens: string }[],
    headHeight: string | null
  ): Promise<Map<string, StakeDelta>>;
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
  getProposalVotes(
    id: string,
    /** Voting window, so the indexer can be trusted only where it has cover. */
    window?: { start: string | null; end: string | null }
  ): Promise<ProposalVotes>;
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
        slashingWindow: false,
      },
      getOverview: () => gnoOverview(chain),
      getRecentBlocks: (count) => gnoRecentBlocks(chain, count),
      getBlockDetail: (height) => gnoBlockDetail(chain, height),
      getBlockTxs: (block) => gnoBlockTxs(chain, block.height),
      getRecentTxs: () => gnoRecentTxs(chain),
      getTx: (hash) => gnoTx(chain, hash),
      getValidators: () => gnoValidators(chain),
      getDelegators: async () => ({
        delegators: [],
        total: null,
        truncated: false,
        failed: false,
      }),
      getUptime: () =>
        cached(`uptime:${chain.chainId}`, 15_000, () => gnoUptime(chain)),
      getStakeDeltas: async () => new Map(),
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
      slashingWindow: true,
    },
    getOverview: () => getChainOverview(chain),
    getRecentBlocks: (count) => getRecentBlocks(chain, count),
    getBlockDetail: (height) => getBlockDetail(chain, height),
    getBlockTxs: (block) =>
      txsAtHeight(chain, block.height, block.rawTxs ?? [], block.time),
    getRecentTxs: () => getRecentTxs(chain),
    getTx: (hash) => getTx(chain, hash),
    getValidators: () =>
      cached(`validators:${chain.chainId}`, 30_000, () => getValidators(chain)),
    getDelegators: (operatorAddress) =>
      cached(`delegators:${chain.chainId}:${operatorAddress}`, 30_000, () =>
        getValidatorDelegators(chain, operatorAddress)
      ),
    getUptime: (validators) =>
      cached(`uptime:${chain.chainId}`, 15_000, () =>
        getCosmosUptime(chain, validators)
      ),
    getStakeDeltas: (validators, headHeight) =>
      cached(`stakedelta:${chain.chainId}`, 60_000, () =>
        getStakeDeltas(chain, validators, headHeight)
      ),
    getRegisteredCount: async () => null,
    getAccount: (address) => getCosmosAccount(chain, address),
    getAccountTxs: (address) => getCosmosAccountTxs(chain, address),
    getProposals: (limit) => getProposals(chain, limit),
    getProposal: (id) => getProposal(chain, id),
    // Cached and coalesced: a finished proposal is reconstructed from tens of
    // paged tx-search requests, and without this every viewer repeats all of
    // them. Votes only change while voting is open, so 60s is conservative.
    getProposalVotes: (id, window) =>
      cached(`votes:${chain.chainId}:${id}`, 60_000, () =>
        getProposalVotes(chain, id, undefined, window)
      ),
    getGovParams: () => getGovParams(chain),
  };
}
