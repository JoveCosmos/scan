import { createHash } from "node:crypto";
import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";
import { recentFacts } from "@/lib/block-facts";
import {
  recentTxsFromIndexer,
  type IndexedAccountTx,
} from "@/lib/indexer-db";
import { isCosmosTxHash } from "@/lib/input";
import {
  flattenMessages,
  primaryTransfer,
  transferOf,
  type RawMessage,
  type TxTransfer,
} from "@/lib/tx-parties";

export interface TxMessage {
  typeUrl: string;
  label: string;
  /** Parties and amount, where the message type has them. */
  transfer: TxTransfer | null;
}

export interface TxSummary {
  hash: string;
  height: string;
  time: string | null;
  /** ABCI result code; 0 is success. null when only the hash is known. */
  code: number | null;
  messages: TxMessage[];
  messageCount: number;
  /** One-line summary of what the transaction moved, for list views. */
  transfer: TxTransfer | null;
  fee: { denom: string; amount: string }[];
  gasUsed: string | null;
  gasWanted: string | null;
  memo: string;
}

export interface TxDetail extends TxSummary {
  rawLog: string;
  signers: string[];
  timeoutHeight: string | null;
}

export interface RawTxResponse {
  txhash: string;
  height: string;
  code: number;
  gas_used: string;
  gas_wanted: string;
  timestamp: string;
  raw_log: string;
  tx?: {
    body?: {
      messages?: { "@type": string }[];
      memo?: string;
      timeout_height?: string;
    };
    auth_info?: {
      fee?: { amount?: { denom: string; amount: string }[] };
      signer_infos?: unknown[];
    };
  };
}

interface TxsByHeightResponse {
  tx_responses?: RawTxResponse[];
}
interface SingleTxResponse {
  tx_response?: RawTxResponse;
}
/**
 * A Cosmos tx hash is the SHA-256 of the raw (base64) tx bytes as included in the
 * block — verified to match the node's own `txhash`. Computing it locally means
 * the tx list still works against nodes with transaction indexing switched off.
 */
export function txHashFromBase64(rawTx: string): string {
  return createHash("sha256")
    .update(Buffer.from(rawTx, "base64"))
    .digest("hex")
    .toUpperCase();
}

const MESSAGE_LABELS: Record<string, string> = {
  MsgSend: "Send",
  MsgMultiSend: "Multi Send",
  MsgDelegate: "Delegate",
  MsgUndelegate: "Undelegate",
  MsgBeginRedelegate: "Redelegate",
  MsgCancelUnbondingDelegation: "Cancel Unbonding",
  MsgWithdrawDelegatorReward: "Claim Rewards",
  MsgWithdrawValidatorCommission: "Claim Commission",
  MsgSetWithdrawAddress: "Set Withdraw Address",
  MsgVote: "Vote",
  MsgVoteWeighted: "Weighted Vote",
  MsgDeposit: "Deposit",
  MsgSubmitProposal: "Submit Proposal",
  MsgTransfer: "IBC Transfer",
  MsgUpdateClient: "IBC Update Client",
  MsgAcknowledgement: "IBC Acknowledgement",
  MsgRecvPacket: "IBC Receive",
  MsgTimeout: "IBC Timeout",
  MsgExecuteContract: "Execute Contract",
  MsgInstantiateContract: "Instantiate Contract",
  MsgStoreCode: "Store Code",
  MsgExec: "Authz Exec",
  MsgGrant: "Authz Grant",
  MsgRevoke: "Authz Revoke",
  MsgCreateValidator: "Create Validator",
  MsgEditValidator: "Edit Validator",
  MsgUnjail: "Unjail",
};

/** "/cosmos.bank.v1beta1.MsgSend" -> "Send" (falling back to the bare type name). */
export function labelForType(typeUrl: string): string {
  const name = typeUrl.split(".").pop() ?? typeUrl;
  if (MESSAGE_LABELS[name]) return MESSAGE_LABELS[name];
  return name.replace(/^Msg/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Shared with the account history reader, which hits the same tx endpoint. */
export function rawTxToSummary(raw: RawTxResponse): TxSummary {
  // Flattened first: an authz MsgExec would otherwise present as a transaction
  // with one opaque message and no parties.
  const rawMessages = flattenMessages(
    (raw.tx?.body?.messages ?? []) as RawMessage[]
  );
  const messages = rawMessages.map((m) => ({
    typeUrl: m["@type"],
    label: labelForType(m["@type"]),
    transfer: transferOf(m),
  }));

  return {
    hash: raw.txhash,
    height: raw.height,
    time: raw.timestamp ?? null,
    code: raw.code ?? 0,
    messages,
    messageCount: messages.length,
    transfer: primaryTransfer(rawMessages),
    fee: raw.tx?.auth_info?.fee?.amount ?? [],
    gasUsed: raw.gas_used ?? null,
    gasWanted: raw.gas_wanted ?? null,
    memo: raw.tx?.body?.memo ?? "",
  };
}

export function txsAtHeight(
  chain: ChainConfig,
  height: string,
  fallbackRawTxs: string[],
  blockTime: string
): Promise<TxSummary[]> {
  return txsAtHeightByHash(chain, height, fallbackRawTxs.map(txHashFromBase64), blockTime);
}

/**
 * A committed block's transactions never change, so they are cached by height:
 * the feed polls every few seconds and should only ever resolve new blocks.
 */
function txsAtHeightByHash(
  chain: ChainConfig,
  height: string,
  fallbackHashes: string[],
  blockTime: string
): Promise<TxSummary[]> {
  return cached(`txsat:${chain.chainId}:${height}`, 30 * 60_000, () =>
    readTxsAtHeight(chain, height, fallbackHashes, blockTime)
  );
}

async function readTxsAtHeight(
  chain: ChainConfig,
  height: string,
  fallbackHashes: string[],
  blockTime: string
): Promise<TxSummary[]> {
  try {
    const res = await fetchLcd<TxsByHeightResponse>(chain, "/cosmos/tx/v1beta1/txs", {
      cache: "no-store",
      timeoutMs: 8000,
      searchParams: { query: `tx.height=${height}`, "pagination.limit": 100 },
    });
    if (res.tx_responses?.length) return res.tx_responses.map(rawTxToSummary);
  } catch {
    // Indexing disabled or endpoint unhappy — fall through to hashes-only.
  }

  // Degraded mode: we still know each tx's hash and which block it landed in,
  // which is enough to list it and link to its detail page.
  return fallbackHashes.map((hash) => ({
    hash,
    height,
    time: blockTime,
    code: null,
    messages: [],
    messageCount: 0,
    transfer: null,
    fee: [],
    gasUsed: null,
    gasWanted: null,
    memo: "",
  }));
}

/**
 * Recent transactions, assembled by walking back from the head block. There is no
 * "latest transactions" endpoint in the Cosmos REST API, and chains vary wildly in
 * throughput, so we scan a bounded window of blocks and stop once we have enough.
 */
/**
 * An indexed row in the shape the list views already render.
 *
 * Shared by the account history and the recent-transactions tab, which read
 * the same columns and differ only in what they select on.
 *
 * The index stores extracted facts rather than transaction bodies, so a few
 * fields a raw tx would carry are simply absent: gas is not kept, and memos
 * are not either. Null says so rather than implying zero.
 */
export function indexedTxToSummary(t: IndexedAccountTx): TxSummary {
  return {
    hash: t.hash,
    height: t.height,
    time: t.time,
    code: t.code,
    messages: t.msgTypes.map((typeUrl) => ({
      typeUrl,
      label: labelForType(typeUrl),
      // Per-message parties are not indexed; the tx-level transfer below
      // carries the movement this account was party to.
      transfer: null,
    })),
    messageCount: t.msgTypes.length,
    transfer: t.transfer
      ? {
          from: t.transfer.from,
          to: t.transfer.to,
          amount: [{ denom: t.transfer.denom, amount: t.transfer.amount }],
          // Bank transfers between accounts; staking movements are their own
          // event kinds and are not matched here.
          staking: false,
        }
      : null,
    fee:
      t.feeDenom && t.feeAmount
        ? [{ denom: t.feeDenom, amount: t.feeAmount }]
        : [],
    gasUsed: null,
    gasWanted: null,
    memo: "",
  };
}

export async function getRecentTxs(
  chain: ChainConfig,
  { maxTxs = 30, maxBlocks = 30 }: { maxTxs?: number; maxBlocks?: number } = {}
): Promise<{ txs: TxSummary[]; scannedBlocks: number; headHeight: string | null }> {
  // Indexed first. Scanning a block window answers "what happened lately"; on a
  // chain with mostly empty blocks that shows two transactions while thousands
  // exist, because the window is the limit rather than the activity.
  const indexed = await recentTxsFromIndexer(chain.chainId, maxTxs).catch(
    () => null
  );
  if (indexed && indexed.length > 0) {
    return {
      txs: indexed.map(indexedTxToSummary),
      // Not a window — these are the last transactions, not a slice of blocks.
      scannedBlocks: 0,
      headHeight: indexed[0]?.height ?? null,
    };
  }

  // The same cached heights the blocks feed reads, so between them each block
  // is fetched once and each block's transactions resolved once.
  let facts;
  try {
    facts = await recentFacts(chain, maxBlocks);
  } catch {
    return { txs: [], scannedBlocks: 0, headHeight: null };
  }
  const headHeight = facts[0]?.summary.height ?? null;

  // Newest first; take enough blocks to satisfy maxTxs, then resolve them in
  // parallel — sequentially cost several seconds on chains with sparse blocks.
  const needed: typeof facts = [];
  let running = 0;
  for (const block of facts) {
    if (block.txHashes.length === 0) continue;
    if (running >= maxTxs) break;
    needed.push(block);
    running += block.txHashes.length;
  }

  const resolved = await Promise.all(
    needed.map((block) =>
      txsAtHeightByHash(chain, block.summary.height, block.txHashes, block.summary.time)
    )
  );

  return {
    txs: resolved.flat().slice(0, maxTxs),
    scannedBlocks: facts.length,
    headHeight,
  };
}

export async function getTx(
  chain: ChainConfig,
  hash: string
): Promise<TxDetail | null> {
  // Hashes are interpolated into an LCD path. See lib/input.ts.
  if (!isCosmosTxHash(hash)) return null;

  try {
    const res = await fetchLcd<SingleTxResponse>(
      chain,
      `/cosmos/tx/v1beta1/txs/${hash.toUpperCase()}`,
      { cache: "no-store", timeoutMs: 10_000 }
    );
    if (!res.tx_response) return null;

    const raw = res.tx_response;
    return {
      ...rawTxToSummary(raw),
      rawLog: raw.raw_log ?? "",
      signers: [],
      timeoutHeight: raw.tx?.body?.timeout_height ?? null,
    };
  } catch {
    return null;
  }
}
