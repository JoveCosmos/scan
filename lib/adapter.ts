import type { ChainConfig } from "@/lib/chains";
import type { ChainOverview } from "@/lib/overview";
import { getChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import { getRecentBlocks, getBlockDetail, type AbsentValidator } from "@/lib/blocks";
import { txsAtHeight } from "@/lib/txs";
import type { TxSummary, TxDetail } from "@/lib/txs";
import { getRecentTxs, getTx } from "@/lib/txs";
import type { ValidatorSummary } from "@/lib/validators";
import {
  getInactiveValidators,
  getValidatorsCached,
  getValidatorDelegators,
} from "@/lib/validators";
import type { Delegator } from "@/lib/validators";
import type { ValidatorUptime } from "@/lib/uptime";
import type { StakeDelta } from "@/lib/stake-delta";
import { getStakeDeltas } from "@/lib/stake-delta";
import { getCosmosUptime } from "@/lib/uptime";
import { cached } from "@/lib/cache";
import type { AccountView } from "@/lib/accounts";
import {
  getCosmosAccount,
  getCosmosAccountTxs,
  type AccountTxs,
  type AccountTxsOptions,
} from "@/lib/accounts";
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
  gnoInactiveValidators,
} from "@/lib/gno";

/**
 * Cosmos can return a full detail record; gno's indexing API exposes no raw log
 * or signer list, so those fields are optional across the adapter boundary.
 */
export type TxView = TxSummary &
  Partial<
    Pick<
      TxDetail,
      | "rawLog"
      | "signers"
      | "timeoutHeight"
      | "codespace"
      | "feePayer"
      | "feeGranter"
      | "gasLimit"
      | "events"
      | "rawJson"
    >
  >;

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
  /** Bech32 consensus address of the proposer, where it can be derived. */
  proposerValcons?: string | null;
  signedCount?: number | null;
  absentCount?: number | null;
  absentValidators?: AbsentValidator[] | null;
  gasUsed?: string | null;
  gasWanted?: string | null;
  totalFees?: string | null;
  rawTxs?: string[];
};

export interface RecentTxs {
  txs: TxSummary[];
  scannedBlocks: number;
  headHeight: string | null;
  /** The newest block available was hours old: nothing here is "latest". */
  stale?: boolean;
}

/**
 * Capabilities differ per chain kind, so the UI can hide columns that would
 * otherwise render as meaningless zeros (gno.land has no staking module).
 */
export interface ChainCapabilities {
  staking: boolean;
  gas: boolean;
  /** Whether tx hashes are hex (Cosmos) or base64 (gno) - affects URL encoding. */
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
  /** The `count` blocks below `before`, newest first: the blocks list's older pages. */
  getRecentTxs(): Promise<RecentTxs>;
  getTx(hash: string): Promise<TxView | null>;
  getValidators(): Promise<ValidatorSummary[]>;
  /** Validators outside the active set. Empty where there is no such notion. */
  getInactiveValidators(): Promise<ValidatorSummary[]>;
  /** Delegators to one validator, largest first, one page at a time. */
  getDelegators(
    operatorAddress: string,
    page?: { offset: number; limit: number }
  ): Promise<{
    delegators: Delegator[];
    /** Rank of the first row, 1-based offset into the ranking. */
    offset?: number;
    /** Share held by the ten largest delegators, 0–1. */
    top10Share?: number | null;
    total: number | null;
    /** True when the delegation read hit its page cap, so ranking may be partial. */
    truncated: boolean;
    failed: boolean;
  }>;
  /** Signing history keyed by the same id the validator list uses. */
  getUptime(
    validators: { operatorAddress: string; consensusPubkey: string | null }[],
    /** Bars of recent signing history. One block read per bar, per chain. */
    barCount?: number
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
  /** Transactions this address sent or received, one page at a time. */
  getAccountTxs(address: string, options?: AccountTxsOptions): Promise<AccountTxs>;
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
      // Registered in the valopers realm but holding no voting power now.
      getInactiveValidators: () =>
        cached(`gno-inactive:${chain.chainId}`, 60_000, () => gnoInactiveValidators(chain), {
          staleMs: 10 * 60_000,
        }).catch(() => []),
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
      getAccountTxs: (address, options) =>
        gnoAccountTxs(chain, address, options?.limit ?? 50, options?.cursor),
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
    getValidators: () => getValidatorsCached(chain),
    getInactiveValidators: () => getInactiveValidators(chain),
    // The ranked list is cached inside; each page is a slice of it.
    getDelegators: (operatorAddress, page) =>
      getValidatorDelegators(chain, operatorAddress, page),
    // Not cached as a whole: the result is keyed by whichever validators were
    // asked about, so one cache entry per bar count handed a validator page the
    // map built for a different validator. The expensive parts (signing infos,
    // blocks) are cached underneath, and assembling the map is arithmetic.
    getUptime: (validators, barCount) => getCosmosUptime(chain, validators, barCount),
    getStakeDeltas: (validators, headHeight) =>
      cached(
        `stakedelta:${chain.chainId}`,
        60_000,
        () => getStakeDeltas(chain, validators, headHeight),
        { staleMs: 15 * 60_000 }
      ),
    getRegisteredCount: async () => null,
    getAccount: (address) => getCosmosAccount(chain, address),
    getAccountTxs: (address, options) => getCosmosAccountTxs(chain, address, options),
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
