import type { ChainConfig } from "@/lib/chains";
import { fetchFrom } from "@/lib/lcd";
import type { ChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import type { TxSummary } from "@/lib/txs";
import type { ValidatorSummary } from "@/lib/validators";

/*
 * gno.land runs Tendermint2, not the Cosmos SDK. There is no /cosmos/* REST API,
 * no staking module, and the RPC ships with transaction indexing disabled — its
 * /tx_search route 404s. Chain head and the validator set therefore come from
 * JSON-RPC, while blocks and transactions come from an indexing REST API.
 */

interface RpcEnvelope<T> {
  result?: T;
  error?: { message?: string };
}

interface StatusResult {
  node_info: { network: string; moniker: string };
  sync_info: { latest_block_height: string; latest_block_time: string };
}

interface ValidatorsResult {
  block_height: string;
  validators: { address: string; voting_power: string }[];
}

async function gnoRpc<T>(
  chain: ChainConfig,
  path: string,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const res = await fetchFrom<RpcEnvelope<T>>(
    chain.rpcEndpoints,
    path,
    { cache: "no-store", timeoutMs: opts.timeoutMs ?? 8000 },
    `${chain.chainId} rpc`
  );
  if (!res.result) {
    throw new Error(res.error?.message ?? `Empty RPC result for ${path}`);
  }
  return res.result;
}

async function gnoApi<T>(
  chain: ChainConfig,
  path: string,
  searchParams?: Record<string, string | number | boolean | undefined>,
  timeoutMs = 10_000
): Promise<T> {
  const res = await fetchFrom<{ data?: T }>(
    chain.apiEndpoints,
    path,
    { cache: "no-store", timeoutMs, searchParams },
    `${chain.chainId} api`
  );
  if (res.data === undefined) throw new Error(`Empty API payload for ${path}`);
  return res.data;
}

interface ApiBlockItem {
  blockHash: string;
  blockProposer: string;
  blockProposerLabel: string;
  timestamp: string;
  blockHeight: number;
  totalFees: number;
  transactionCount: number;
}

interface ApiTxItem {
  txHash: string;
  fee: { value: string; denom: string };
  timestamp: string;
  blockHeight: number;
  messageCount: number;
  successYn: boolean;
  func: { messageType: string; funcType: string; pkgPath: string }[];
}

/** "/vm.m_call" + funcType "Approve" reads better as "Approve". */
function labelForGnoMessage(fn: {
  messageType: string;
  funcType: string;
  pkgPath: string;
}): string {
  if (fn.funcType) return fn.funcType;
  const bare = fn.messageType.replace(/^\//, "").replace(/^vm\.|^bank\./, "");
  return bare.replace(/^m_/, "").replace(/^([a-z])/, (m) => m.toUpperCase());
}

function toTxSummary(item: ApiTxItem): TxSummary {
  const messages = (item.func ?? []).map((fn) => ({
    typeUrl: fn.pkgPath ? `${fn.messageType} ${fn.pkgPath}` : fn.messageType,
    label: labelForGnoMessage(fn),
  }));

  return {
    hash: item.txHash,
    height: String(item.blockHeight),
    time: item.timestamp,
    // The API reports success as a boolean; map onto the ABCI convention where 0
    // means success so the shared UI can render it unchanged.
    code: item.successYn ? 0 : 1,
    messages,
    messageCount: item.messageCount ?? messages.length,
    fee: item.fee?.value
      ? [{ denom: item.fee.denom, amount: item.fee.value }]
      : [],
    gasUsed: null,
    gasWanted: null,
    memo: "",
  };
}

function toBlockSummary(item: ApiBlockItem): BlockSummary {
  return {
    height: String(item.blockHeight),
    time: item.timestamp,
    txCount: item.transactionCount ?? 0,
    proposer: item.blockProposerLabel || item.blockProposer,
    hash: item.blockHash,
  };
}

export async function gnoOverview(chain: ChainConfig): Promise<ChainOverview> {
  const [status, validators, blocks] = await Promise.allSettled([
    gnoRpc<StatusResult>(chain, "/status"),
    gnoRpc<ValidatorsResult>(chain, "/validators"),
    gnoApi<{ items: ApiBlockItem[] }>(chain, "/blocks", { limit: 1 }),
  ]);

  const head = status.status === "fulfilled" ? status.value.sync_info : null;

  return {
    height: head?.latest_block_height ?? null,
    blockTime: head?.latest_block_time ?? null,
    txCount:
      blocks.status === "fulfilled"
        ? (blocks.value.items?.[0]?.transactionCount ?? null)
        : null,
    activeValidators:
      validators.status === "fulfilled" ? validators.value.validators.length : null,
    // gno.land has no staking module, so there is no bonded ratio or supply to
    // report here. Left null so the UI renders "—" rather than a fabricated 0.
    bondedRatio: null,
    bondedTokens: null,
    supply: null,
  };
}

export async function gnoRecentBlocks(
  chain: ChainConfig,
  count = 15
): Promise<BlockSummary[]> {
  const data = await gnoApi<{ items: ApiBlockItem[] }>(chain, "/blocks", {
    limit: count,
  });
  return (data.items ?? []).map(toBlockSummary);
}

export async function gnoBlock(
  chain: ChainConfig,
  height: string | number
): Promise<BlockSummary | null> {
  try {
    const data = await gnoApi<{ items: ApiBlockItem[] }>(chain, "/blocks", {
      limit: 1,
      fromBlockHeight: height,
      toBlockHeight: height,
    });
    const hit = data.items?.find((b) => String(b.blockHeight) === String(height));
    return hit ? toBlockSummary(hit) : null;
  } catch {
    return null;
  }
}

export async function gnoRecentTxs(
  chain: ChainConfig,
  count = 20
): Promise<{ txs: TxSummary[]; scannedBlocks: number; headHeight: string | null }> {
  const [txs, status] = await Promise.allSettled([
    gnoApi<{ items: ApiTxItem[] }>(chain, "/transactions", { limit: count }),
    gnoRpc<StatusResult>(chain, "/status"),
  ]);

  return {
    txs:
      txs.status === "fulfilled" ? (txs.value.items ?? []).map(toTxSummary) : [],
    scannedBlocks: 0,
    headHeight:
      status.status === "fulfilled" ? status.value.sync_info.latest_block_height : null,
  };
}

interface ApiTxDetail {
  txHash: string;
  timestamp: string;
  blockHeight: number;
  memo: string;
  errorLog: string;
  success: boolean;
  transactionFee: { value: string; denom: string };
  gas: { used: number; wanted: number; usedPercentage: string };
}

/** Coarse message list from the GraphQL indexer — the REST detail omits messages. */
async function gnoTxMessages(
  chain: ChainConfig,
  hash: string
): Promise<{ typeUrl: string; label: string }[]> {
  const endpoint = chain.indexerEndpoints[0];
  if (!endpoint) return [];

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ transactions(filter: {hash: ${JSON.stringify(hash)}}) { messages { route typeUrl } } }`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];

    const json = (await res.json()) as {
      data?: { transactions?: { messages?: { route: string; typeUrl: string }[] }[] };
    };
    const messages = json.data?.transactions?.[0]?.messages ?? [];
    return messages.map((m) => ({
      typeUrl: `/${m.route}.${m.typeUrl}`,
      label: labelForGnoMessage({
        messageType: `/${m.route}.${m.typeUrl}`,
        funcType: "",
        pkgPath: "",
      }),
    }));
  } catch {
    return [];
  }
}

/**
 * The REST list endpoint silently ignores a `txHash` filter — it returns the
 * newest page regardless — so a single tx must be read from /transactions/{hash}.
 * That record carries gas, memo and the error log but no messages, which come
 * from the GraphQL indexer instead. Either source may be missing without
 * failing the lookup.
 */
export async function gnoTx(
  chain: ChainConfig,
  hash: string
): Promise<(TxSummary & { rawLog: string }) | null> {
  let detail: ApiTxDetail;
  try {
    // This endpoint nests its payload one level deeper than the list endpoints.
    const wrapper = await gnoApi<{ data: ApiTxDetail } | ApiTxDetail>(
      chain,
      `/transactions/${encodeURIComponent(hash)}`
    );
    detail = ("data" in wrapper ? wrapper.data : wrapper) as ApiTxDetail;
    if (!detail?.txHash) return null;
  } catch {
    return null;
  }

  const messages = await gnoTxMessages(chain, detail.txHash);

  return {
    hash: detail.txHash,
    height: String(detail.blockHeight),
    time: detail.timestamp,
    code: detail.success ? 0 : 1,
    messages,
    messageCount: messages.length,
    fee: detail.transactionFee?.value
      ? [{ denom: detail.transactionFee.denom, amount: detail.transactionFee.value }]
      : [],
    gasUsed: detail.gas ? String(detail.gas.used) : null,
    gasWanted: detail.gas ? String(detail.gas.wanted) : null,
    memo: detail.memo ?? "",
    rawLog: detail.errorLog ?? "",
  };
}

/**
 * The consensus set from JSON-RPC. gno.land has no staking module, so "voting
 * power" is the raw Tendermint power rather than a bonded-token share, and
 * commission/jailed have no meaning here.
 */
export async function gnoValidators(chain: ChainConfig): Promise<ValidatorSummary[]> {
  const res = await gnoRpc<ValidatorsResult>(chain, "/validators", {
    timeoutMs: 12_000,
  });

  const ranked = [...res.validators].sort(
    (a, b) => Number(b.voting_power) - Number(a.voting_power)
  );
  const totalPower = ranked.reduce((sum, v) => sum + Number(v.voting_power), 0);

  let running = 0;
  return ranked.map((v, i) => {
    const power = totalPower > 0 ? Number(v.voting_power) / totalPower : 0;
    running += power;
    return {
      rank: i + 1,
      operatorAddress: v.address,
      moniker: v.address,
      website: "",
      jailed: false,
      status: "BOND_STATUS_BONDED",
      tokens: v.voting_power,
      votingPower: power,
      cumulativePower: running,
      commissionRate: 0,
    };
  });
}
