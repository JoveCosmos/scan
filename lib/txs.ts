import { createHash } from "node:crypto";
import type { ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

export interface TxMessage {
  typeUrl: string;
  label: string;
}

export interface TxSummary {
  hash: string;
  height: string;
  time: string | null;
  /** ABCI result code; 0 is success. null when only the hash is known. */
  code: number | null;
  messages: TxMessage[];
  messageCount: number;
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

interface RawTxResponse {
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
interface BlockResponse {
  block: {
    header: { height: string; time: string };
    data: { txs: string[] | null };
  };
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

function toSummary(raw: RawTxResponse): TxSummary {
  const messages = (raw.tx?.body?.messages ?? []).map((m) => ({
    typeUrl: m["@type"],
    label: labelForType(m["@type"]),
  }));

  return {
    hash: raw.txhash,
    height: raw.height,
    time: raw.timestamp ?? null,
    code: raw.code ?? 0,
    messages,
    messageCount: messages.length,
    fee: raw.tx?.auth_info?.fee?.amount ?? [],
    gasUsed: raw.gas_used ?? null,
    gasWanted: raw.gas_wanted ?? null,
    memo: raw.tx?.body?.memo ?? "",
  };
}

export async function txsAtHeight(
  chain: ChainConfig,
  height: string,
  fallbackRawTxs: string[],
  blockTime: string
): Promise<TxSummary[]> {
  try {
    const res = await fetchLcd<TxsByHeightResponse>(chain, "/cosmos/tx/v1beta1/txs", {
      cache: "no-store",
      timeoutMs: 8000,
      searchParams: { query: `tx.height=${height}`, "pagination.limit": 100 },
    });
    if (res.tx_responses?.length) return res.tx_responses.map(toSummary);
  } catch {
    // Indexing disabled or endpoint unhappy — fall through to hashes-only.
  }

  // Degraded mode: we still know each tx's hash and which block it landed in,
  // which is enough to list it and link to its detail page.
  return fallbackRawTxs.map((raw) => ({
    hash: txHashFromBase64(raw),
    height,
    time: blockTime,
    code: null,
    messages: [],
    messageCount: 0,
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
export async function getRecentTxs(
  chain: ChainConfig,
  { maxTxs = 20, maxBlocks = 20 }: { maxTxs?: number; maxBlocks?: number } = {}
): Promise<{ txs: TxSummary[]; scannedBlocks: number; headHeight: string | null }> {
  let head: number;
  let headHeight: string | null = null;

  try {
    const latest = await fetchLcd<BlockResponse>(
      chain,
      "/cosmos/base/tendermint/v1beta1/blocks/latest",
      { cache: "no-store" }
    );
    head = Number(latest.block.header.height);
    headHeight = latest.block.header.height;
  } catch {
    return { txs: [], scannedBlocks: 0, headHeight: null };
  }

  if (!Number.isFinite(head)) return { txs: [], scannedBlocks: 0, headHeight };

  const heights = Array.from({ length: maxBlocks }, (_, i) => head - i).filter(
    (h) => h > 0
  );

  const blocks = await Promise.allSettled(
    heights.map((h) =>
      fetchLcd<BlockResponse>(chain, `/cosmos/base/tendermint/v1beta1/blocks/${h}`, {
        cache: "no-store",
      })
    )
  );

  const withTxs = blocks
    .filter((b): b is PromiseFulfilledResult<BlockResponse> => b.status === "fulfilled")
    .map((b) => b.value)
    .filter((b) => (b.block.data.txs?.length ?? 0) > 0)
    .sort((a, b) => Number(b.block.header.height) - Number(a.block.header.height));

  // Take enough blocks to satisfy maxTxs, then resolve them in parallel — doing
  // this sequentially cost several seconds on chains with sparse blocks.
  const needed: typeof withTxs = [];
  let running = 0;
  for (const block of withTxs) {
    if (running >= maxTxs) break;
    needed.push(block);
    running += block.block.data.txs?.length ?? 0;
  }

  const resolved = await Promise.all(
    needed.map((block) =>
      txsAtHeight(
        chain,
        block.block.header.height,
        block.block.data.txs ?? [],
        block.block.header.time
      )
    )
  );

  const collected = resolved.flat();

  return {
    txs: collected.slice(0, maxTxs),
    scannedBlocks: heights.length,
    headHeight,
  };
}

export async function getTx(
  chain: ChainConfig,
  hash: string
): Promise<TxDetail | null> {
  try {
    const res = await fetchLcd<SingleTxResponse>(
      chain,
      `/cosmos/tx/v1beta1/txs/${hash.toUpperCase()}`,
      { cache: "no-store", timeoutMs: 10_000 }
    );
    if (!res.tx_response) return null;

    const raw = res.tx_response;
    return {
      ...toSummary(raw),
      rawLog: raw.raw_log ?? "",
      signers: [],
      timeoutHeight: raw.tx?.body?.timeout_height ?? null,
    };
  } catch {
    return null;
  }
}
