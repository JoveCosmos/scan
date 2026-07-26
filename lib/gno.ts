import type { ChainConfig } from "@/lib/chains";
import { fetchFrom } from "@/lib/lcd";
import type { ChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import type { TxSummary } from "@/lib/txs";
import type { ValidatorSummary } from "@/lib/validators";
import { getValoperIndexNow, prewarmValoperIndex } from "@/lib/gno-valopers";
import { parseCoinString, type AccountView } from "@/lib/accounts";

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

/** Raw ABCI query. The address lives in the path; data is empty. */
async function abciQuery(
  chain: ChainConfig,
  path: string,
  timeoutMs = 8000
): Promise<string | null> {
  for (const endpoint of chain.rpcEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "abci_query",
          params: { path, data: "" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;

      const json = (await res.json()) as {
        error?: unknown;
        result?: { response?: { ResponseBase?: { Data?: string; Error?: unknown } } };
      };
      if (json.error) continue;

      const base = json.result?.response?.ResponseBase;
      if (!base || base.Error) return null;

      return Buffer.from(base.Data ?? "", "base64").toString();
    } catch {
      continue;
    }
  }
  return null;
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
  // Landing on any gno page starts the realm index warming, so the validator
  // list is usually ready by the time it is opened.
  prewarmValoperIndex(chain);

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

interface ApiBlockDetail {
  blockHash: string;
  chainID: string;
  timestamp: string;
  proposerAddress: string;
  proposerLabel: string;
  blockHeight: number;
  gasUsed: number;
  gasWanted: number;
  totalFees: number;
  transactionCount: number;
}

export interface GnoBlockDetail extends BlockSummary {
  chainId: string | null;
  proposerLabel: string | null;
  gasUsed: string | null;
  gasWanted: string | null;
  totalFees: string | null;
}

export async function gnoBlockDetail(
  chain: ChainConfig,
  height: string | number
): Promise<GnoBlockDetail | null> {
  let detail: ApiBlockDetail;
  try {
    // Single-record endpoints nest their payload one level deeper than lists.
    const wrapper = await gnoApi<{ data: ApiBlockDetail } | ApiBlockDetail>(
      chain,
      `/blocks/${height}`
    );
    detail = ("data" in wrapper ? wrapper.data : wrapper) as ApiBlockDetail;
  } catch {
    return null;
  }

  // A height that does not exist comes back as 200 with an all-zero record
  // rather than a 404, so emptiness is the only available "missing" signal.
  if (!detail || !detail.blockHash || detail.blockHeight === 0) return null;

  return {
    height: String(detail.blockHeight),
    time: detail.timestamp,
    txCount: detail.transactionCount ?? 0,
    proposer: detail.proposerAddress,
    hash: detail.blockHash,
    chainId: detail.chainID || null,
    proposerLabel: detail.proposerLabel || null,
    gasUsed: detail.gasUsed ? String(detail.gasUsed) : null,
    gasWanted: detail.gasWanted ? String(detail.gasWanted) : null,
    totalFees: detail.totalFees ? String(detail.totalFees) : null,
  };
}

export async function gnoBlockTxs(
  chain: ChainConfig,
  height: string | number
): Promise<TxSummary[]> {
  try {
    const data = await gnoApi<{ items: ApiTxItem[] }>(
      chain,
      `/blocks/${height}/transactions`
    );
    return (data.items ?? []).map(toTxSummary);
  } catch {
    return [];
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

interface ApiValidatorItem {
  monikerName: string;
  status: string;
  address: string;
  votingPower: string;
  shareRate: string;
  firstCommittedHeight: number | null;
  firstCommittedTime: string | null;
}

/**
 * signing address -> moniker. Best-effort and time-boxed: on a cold cache the
 * realm index takes ~15s to build, so the listing renders with addresses rather
 * than stalling, and the build continues for the next request.
 */
async function valoperMonikers(chain: ChainConfig): Promise<Map<string, string>> {
  try {
    const index = await getValoperIndexNow(chain);
    const map = new Map<string, string>();
    for (const [signing, profile] of index.bySigning) {
      if (profile.moniker) map.set(signing, profile.moniker);
    }
    return map;
  } catch {
    return new Map();
  }
}

function rankValidators(
  entries: { address: string; moniker: string; power: number; status: string }[]
): ValidatorSummary[] {
  const ranked = [...entries].sort((a, b) => b.power - a.power);
  const totalPower = ranked.reduce((sum, v) => sum + v.power, 0);

  let running = 0;
  return ranked.map((v, i) => {
    const share = totalPower > 0 ? v.power / totalPower : 0;
    running += share;
    return {
      rank: i + 1,
      operatorAddress: v.address,
      moniker: v.moniker,
      website: "",
      jailed: false,
      status: v.status,
      tokens: String(v.power),
      votingPower: share,
      cumulativePower: running,
      commissionRate: 0,
    };
  });
}

/**
 * The active consensus set. Preferred source is the indexing API because it
 * carries monikers; the JSON-RPC validator set is the fallback and yields bare
 * addresses. Either way "voting power" is raw Tendermint power — gno.land has
 * no staking module, so commission and jailing have no meaning here.
 */
export async function gnoValidators(chain: ChainConfig): Promise<ValidatorSummary[]> {
  try {
    const data = await gnoApi<{ items: ApiValidatorItem[] }>(chain, "/validators", {
      limit: 100,
    });
    const active = (data.items ?? []).filter((v) => v.status === "ACTIVE");
    if (active.length > 0) {
      // The indexing API knows a moniker for only a couple of validators; the
      // valopers realm is the real identity registry, so prefer it and fall
      // back to whatever the API has.
      const monikers = await valoperMonikers(chain);
      return rankValidators(
        active.map((v) => ({
          address: v.address,
          moniker: monikers.get(v.address) || v.monikerName || v.address,
          power: Number(v.votingPower),
          status: v.status,
        }))
      );
    }
  } catch {
    // Fall through to the RPC consensus set.
  }

  const res = await gnoRpc<ValidatorsResult>(chain, "/validators", {
    timeoutMs: 12_000,
  });
  return rankValidators(
    res.validators.map((v) => ({
      address: v.address,
      moniker: v.address,
      power: Number(v.voting_power),
      status: "ACTIVE",
    }))
  );
}

interface GnoBaseAccount {
  BaseAccount?: {
    address?: string;
    coins?: string;
    account_number?: string;
    sequence?: string;
  };
}

/**
 * gno exposes accounts over ABCI rather than REST, with the address in the query
 * path and the balance as a coin string ("123ugnot") rather than a coin list.
 */
export async function gnoAccount(
  chain: ChainConfig,
  address: string
): Promise<AccountView> {
  const empty: AccountView = {
    address,
    balances: [],
    delegatedTotal: null,
    delegationCount: null,
    accountNumber: null,
    sequence: null,
    exists: false,
  };

  const raw = await abciQuery(chain, `auth/accounts/${address}`);
  if (!raw) return empty;

  let parsed: GnoBaseAccount;
  try {
    parsed = JSON.parse(raw) as GnoBaseAccount;
  } catch {
    return empty;
  }

  const base = parsed.BaseAccount;
  if (!base?.address) return empty;

  return {
    address: base.address,
    balances: parseCoinString(base.coins ?? ""),
    delegatedTotal: null,
    delegationCount: null,
    accountNumber: base.account_number ?? null,
    sequence: base.sequence ?? null,
    exists: true,
  };
}

export interface GnoValidatorDetail {
  address: string;
  moniker: string | null;
  status: string | null;
  votingPower: string | null;
  sharePercent: number | null;
  rank: number | null;
  firstCommittedHeight: number | null;
  firstCommittedTime: string | null;
}

/** Consensus-side facts about one validator, keyed by its signing address. */
export async function gnoValidatorDetail(
  chain: ChainConfig,
  address: string
): Promise<GnoValidatorDetail | null> {
  try {
    const data = await gnoApi<{ items: ApiValidatorItem[] }>(chain, "/validators", {
      limit: 100,
    });
    const items = data.items ?? [];
    const hit = items.find((v) => v.address === address);
    if (!hit) return null;

    const active = items
      .filter((v) => v.status === "ACTIVE")
      .sort((a, b) => Number(b.votingPower) - Number(a.votingPower));
    const rankIndex = active.findIndex((v) => v.address === address);

    const monikers = await valoperMonikers(chain);

    return {
      address: hit.address,
      moniker: monikers.get(hit.address) || hit.monikerName || null,
      status: hit.status,
      votingPower: hit.votingPower,
      sharePercent: hit.shareRate ? Number(hit.shareRate) : null,
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
      firstCommittedHeight: hit.firstCommittedHeight,
      firstCommittedTime: hit.firstCommittedTime,
    };
  } catch {
    return null;
  }
}
