import type { ChainConfig } from "@/lib/chains";
import { fetchFrom } from "@/lib/lcd";
import { isNumericId, isBech32ish } from "@/lib/input";
import { RECENT_BAR_COUNT, type ValidatorUptime } from "@/lib/uptime";
import type { ChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import type { TxSummary, TxMessage } from "@/lib/txs";
import type { ValidatorSummary } from "@/lib/validators";
import { getValoperIndexNow, prewarmValoperIndex } from "@/lib/gno-valopers";
import {
  parseCoinString,
  type AccountView,
  type AccountTxs,
} from "@/lib/accounts";

/*
 * gno.land runs Tendermint2, not the Cosmos SDK. There is no /cosmos/* REST API,
 * no staking module, and the RPC ships with transaction indexing disabled — its
 * /tx_search route 404s. Chain head and the validator set therefore come from
 * JSON-RPC, while blocks and transactions come from our own tx-indexer
 * (gnolang/tx-indexer), which runs beside the node on this box and answers
 * GraphQL. It replaced Onbloc's REST API, which did not follow the network onto
 * gnoland-1 or pearl-1.
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
    `${chain.chainId} rpc`,
    chain.fallbackRpcEndpoints
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
  for (const endpoint of [...chain.rpcEndpoints, ...chain.fallbackRpcEndpoints]) {
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

/**
 * One GraphQL query against the tx-indexer. Values always travel as variables,
 * never spliced into the query text, since heights, hashes and addresses all
 * arrive from the URL.
 *
 * The indexer has no limit argument: a query returns every match, capped at
 * 10,000 rows. Callers bound their queries by height instead.
 */
async function gql<T>(
  chain: ChainConfig,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 10_000
): Promise<T> {
  let lastError: unknown = new Error(`${chain.chainId} has no indexer endpoint`);
  for (const endpoint of chain.indexerEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
      const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (json.errors?.length) throw new Error(json.errors[0].message);
      if (!json.data) throw new Error("indexer returned no data");
      return json.data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

interface IdxBlock {
  hash: string;
  height: number;
  time: string;
  chain_id: string;
  num_txs: number;
  proposer_address_raw: string;
}

const BLOCK_FIELDS = "hash height time chain_id num_txs proposer_address_raw";

type IdxMessageValue =
  | { __typename: "MsgCall"; func: string; pkg_path: string }
  | { __typename: "BankMsgSend" | "MsgAddPackage" | "MsgRun" | "UnexpectedMessage" };

interface IdxTx {
  hash: string;
  index: number;
  block_height: number;
  success: boolean;
  gas_used: number;
  gas_wanted: number;
  gas_fee: { amount: number; denom: string } | null;
  memo: string;
  messages: { typeUrl: string; route: string; value: IdxMessageValue | null }[];
  response: { error: string; log: string } | null;
}

const TX_FIELDS = `hash index block_height success gas_used gas_wanted
  gas_fee { amount denom } memo response { error log }
  messages { typeUrl route value { __typename ... on MsgCall { func pkg_path } } }`;

/** "vm" + "exec" calling Approve reads better as "Approve". */
function labelForGnoMessage(fn: {
  messageType: string;
  funcType: string;
  pkgPath: string;
}): string {
  if (fn.funcType) return fn.funcType;
  const bare = fn.messageType.replace(/^\//, "").replace(/^vm\.|^bank\./, "");
  return bare
    .replace(/^m_/, "")
    .replace(/_/g, " ")
    .replace(/^([a-z])/, (m) => m.toUpperCase());
}

function toTxMessages(tx: IdxTx): TxMessage[] {
  return (tx.messages ?? []).map((m) => {
    const messageType = `/${m.route}.${m.typeUrl}`;
    const call = m.value?.__typename === "MsgCall" ? m.value : null;
    return {
      typeUrl: call?.pkg_path ? `${messageType} ${call.pkg_path}` : messageType,
      label: labelForGnoMessage({
        messageType,
        funcType: call?.func ?? "",
        pkgPath: call?.pkg_path ?? "",
      }),
      transfer: null,
    };
  });
}

function toTxSummary(tx: IdxTx, time: string | null): TxSummary {
  const messages = toTxMessages(tx);
  return {
    hash: tx.hash,
    height: String(tx.block_height),
    time: time ?? "",
    // Map onto the ABCI convention where 0 means success so the shared UI can
    // render it unchanged.
    code: tx.success ? 0 : 1,
    messages,
    messageCount: messages.length,
    transfer: null,
    fee: tx.gas_fee?.amount
      ? [{ denom: tx.gas_fee.denom, amount: String(tx.gas_fee.amount) }]
      : [],
    gasUsed: tx.gas_used ? String(tx.gas_used) : null,
    gasWanted: tx.gas_wanted ? String(tx.gas_wanted) : null,
    memo: tx.memo ?? "",
  };
}

/** Block times for a set of heights — transactions carry a height but no time. */
async function blockTimes(
  chain: ChainConfig,
  heights: number[]
): Promise<Map<number, string>> {
  const unique = [...new Set(heights)];
  if (unique.length === 0) return new Map();
  const data = await gql<{ getBlocks: { height: number; time: string }[] | null }>(
    chain,
    `query($o: [FilterBlock!]) { getBlocks(where: { _or: $o }) { height time } }`,
    { o: unique.map((h) => ({ height: { eq: h } })) }
  );
  return new Map((data.getBlocks ?? []).map((b) => [b.height, b.time]));
}

async function withTimes(chain: ChainConfig, txs: IdxTx[]): Promise<TxSummary[]> {
  const times = await blockTimes(chain, txs.map((t) => t.block_height)).catch(
    () => new Map<number, string>()
  );
  return txs.map((t) => toTxSummary(t, times.get(t.block_height) ?? null));
}

/** signing address -> moniker, from whatever the realm index has ready. */
async function proposerNames(chain: ChainConfig): Promise<Map<string, string>> {
  try {
    const index = await getValoperIndexNow(chain, 300);
    const map = new Map<string, string>();
    for (const [signing, profile] of index.bySigning) {
      if (profile.moniker) map.set(signing, profile.moniker);
    }
    return map;
  } catch {
    return new Map();
  }
}

function toBlockSummary(block: IdxBlock, names: Map<string, string>): BlockSummary {
  return {
    height: String(block.height),
    time: block.time,
    txCount: block.num_txs ?? 0,
    proposer: names.get(block.proposer_address_raw) || block.proposer_address_raw,
    hash: block.hash,
  };
}

async function headHeight(chain: ChainConfig): Promise<number> {
  const status = await gnoRpc<StatusResult>(chain, "/status");
  return Number(status.sync_info.latest_block_height);
}

async function blocksAbove(chain: ChainConfig, above: number): Promise<IdxBlock[]> {
  const data = await gql<{ getBlocks: IdxBlock[] | null }>(
    chain,
    `query($h: Int!) { getBlocks(where: { height: { gt: $h } }, order: { height: DESC }) { ${BLOCK_FIELDS} } }`,
    { h: above }
  );
  return data.getBlocks ?? [];
}

export async function gnoOverview(chain: ChainConfig): Promise<ChainOverview> {
  // Landing on any gno page starts the realm index warming, so the validator
  // list is usually ready by the time it is opened.
  prewarmValoperIndex(chain);

  const [status, validators] = await Promise.allSettled([
    gnoRpc<StatusResult>(chain, "/status"),
    gnoRpc<ValidatorsResult>(chain, "/validators"),
  ]);

  const head = status.status === "fulfilled" ? status.value.sync_info : null;
  const latest = head
    ? await blocksAbove(chain, Number(head.latest_block_height) - 1).catch(() => [])
    : [];

  return {
    height: head?.latest_block_height ?? null,
    blockTime: head?.latest_block_time ?? null,
    txCount: latest[0]?.num_txs ?? null,
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
  count = 30
): Promise<BlockSummary[]> {
  // The indexer can trail the node by a block or two, so anchor on its own head.
  const [idx, names] = await Promise.all([
    gql<{ latestBlockHeight: number }>(chain, "{ latestBlockHeight }"),
    proposerNames(chain),
  ]);
  const blocks = await blocksAbove(chain, idx.latestBlockHeight - count);
  return blocks.slice(0, count).map((b) => toBlockSummary(b, names));
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
  if (!isNumericId(height)) return null;
  const h = Number(height);

  let block: IdxBlock | undefined;
  let txs: IdxTx[] = [];
  try {
    const data = await gql<{ getBlocks: IdxBlock[] | null; getTransactions: IdxTx[] | null }>(
      chain,
      `query($h: Int!) {
        getBlocks(where: { height: { eq: $h } }) { ${BLOCK_FIELDS} }
        getTransactions(where: { block_height: { eq: $h } }) { ${TX_FIELDS} }
      }`,
      { h }
    );
    block = data.getBlocks?.[0];
    txs = data.getTransactions ?? [];
  } catch {
    return null;
  }
  if (!block) return null;

  const names = await proposerNames(chain);
  const sum = (pick: (t: IdxTx) => number) => txs.reduce((acc, t) => acc + (pick(t) || 0), 0);
  const gasUsed = sum((t) => t.gas_used);
  const gasWanted = sum((t) => t.gas_wanted);
  const fees = sum((t) => t.gas_fee?.amount ?? 0);

  return {
    height: String(block.height),
    time: block.time,
    txCount: block.num_txs ?? 0,
    proposer: block.proposer_address_raw,
    hash: block.hash,
    chainId: block.chain_id || null,
    proposerLabel: names.get(block.proposer_address_raw) ?? null,
    gasUsed: gasUsed ? String(gasUsed) : null,
    gasWanted: gasWanted ? String(gasWanted) : null,
    totalFees: fees ? String(fees) : null,
  };
}

export async function gnoBlockTxs(
  chain: ChainConfig,
  height: string | number
): Promise<TxSummary[]> {
  if (!isNumericId(height)) return [];

  try {
    const data = await gql<{ getTransactions: IdxTx[] | null }>(
      chain,
      `query($h: Int!) { getTransactions(where: { block_height: { eq: $h } }, order: { heightAndIndex: ASC }) { ${TX_FIELDS} } }`,
      { h: Number(height) }
    );
    return withTimes(chain, data.getTransactions ?? []);
  } catch {
    return [];
  }
}

/**
 * Transactions are sparse on gno — a quiet testnet can go ten thousand blocks
 * without one — and the indexer takes no limit, so look back in widening
 * windows and stop at the first that holds enough. The last window is the
 * whole chain, which the indexer caps at its newest 10,000 rows.
 */
const TX_WINDOWS = [2_000, 50_000, Number.POSITIVE_INFINITY];

export async function gnoRecentTxs(
  chain: ChainConfig,
  count = 30
): Promise<{ txs: TxSummary[]; scannedBlocks: number; headHeight: string | null }> {
  let head: number | null = null;
  try {
    head = (await gql<{ latestBlockHeight: number }>(chain, "{ latestBlockHeight }"))
      .latestBlockHeight;
  } catch {
    head = await headHeight(chain).catch(() => null);
  }
  if (head === null) return { txs: [], scannedBlocks: 0, headHeight: null };

  let found: IdxTx[] = [];
  for (const window of TX_WINDOWS) {
    const above = Number.isFinite(window) ? Math.max(0, head - window) : 0;
    try {
      const data = await gql<{ getTransactions: IdxTx[] | null }>(
        chain,
        `query($h: Int!) { getTransactions(where: { block_height: { gt: $h } }, order: { heightAndIndex: DESC }) { ${TX_FIELDS} } }`,
        { h: above }
      );
      found = data.getTransactions ?? [];
    } catch {
      break;
    }
    if (found.length >= count) break;
  }

  return {
    txs: await withTimes(chain, found.slice(0, count)),
    scannedBlocks: 0,
    headHeight: String(head),
  };
}

/** A single transaction by hash, with its messages, gas, memo and error log. */
export async function gnoTx(
  chain: ChainConfig,
  hash: string
): Promise<(TxSummary & { rawLog: string }) | null> {
  let tx: IdxTx | undefined;
  try {
    const data = await gql<{ getTransactions: IdxTx[] | null }>(
      chain,
      `query($h: String!) { getTransactions(where: { hash: { eq: $h } }) { ${TX_FIELDS} } }`,
      { h: hash }
    );
    tx = data.getTransactions?.[0];
  } catch {
    return null;
  }
  if (!tx) return null;

  const [summary] = await withTimes(chain, [tx]);
  return { ...summary, rawLog: tx.response?.error ?? "" };
}

/**
 * signing address -> moniker.
 *
 * Every consensus validator has a valopers profile, so falling back to raw
 * addresses is always wrong rather than merely incomplete. The budget is
 * therefore generous: a cold index takes ~25s to build and the listing sits
 * behind a skeleton meanwhile, which beats rendering unreadable addresses.
 * The cap only exists so an unreachable realm cannot hang the page forever.
 */
async function valoperMonikers(chain: ChainConfig): Promise<Map<string, string>> {
  try {
    const index = await getValoperIndexNow(chain, 40_000);
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
      // gno consensus addresses are already the identifier used everywhere;
      // there is no separate pubkey-derived address to carry.
      consensusPubkey: null,
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
 * The active consensus set, from JSON-RPC, named from the valopers realm.
 * "Voting power" is raw Tendermint power — gno.land has no staking module, so
 * commission and jailing have no meaning here.
 */
export async function gnoValidators(chain: ChainConfig): Promise<ValidatorSummary[]> {
  prewarmValoperIndex(chain);
  const [res, monikers] = await Promise.all([
    gnoRpc<ValidatorsResult>(chain, "/validators", { timeoutMs: 12_000 }),
    valoperMonikers(chain),
  ]);

  return rankValidators(
    res.validators.map((v) => ({
      address: v.address,
      moniker: monikers.get(v.address) || v.address,
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

  // An address the chain has never seen answers with the literal "null": valid
  // JSON that parses to null, so neither the parse guard above nor the ABCI
  // error check catches it. Reading .BaseAccount straight off that threw, which
  // is why every mistyped or never-funded gno address returned a 500 where a
  // Cosmos one renders an empty account.
  let parsed: GnoBaseAccount | null;
  try {
    parsed = JSON.parse(raw) as GnoBaseAccount | null;
  } catch {
    return empty;
  }

  const base = parsed?.BaseAccount;
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

/**
 * Transactions this account sent or received, newest first: every message kind
 * that names an address — a bank send either way, a realm call or run by it,
 * a package it deployed.
 */
export async function gnoAccountTxs(
  chain: ChainConfig,
  address: string,
  limit = 50
): Promise<AccountTxs> {
  // gno addresses are bech32 like any other; same gate, same reason.
  if (!isBech32ish(address))
    return { txs: [], total: 0, failed: false, source: "search" as const };

  try {
    const data = await gql<{ getTransactions: IdxTx[] | null }>(
      chain,
      `query($a: String!) {
        getTransactions(
          where: { messages: { value: { _or: [
            { BankMsgSend: { _or: [{ from_address: { eq: $a } }, { to_address: { eq: $a } }] } },
            { MsgCall: { caller: { eq: $a } } },
            { MsgRun: { caller: { eq: $a } } },
            { MsgAddPackage: { creator: { eq: $a } } }
          ] } } }
          order: { heightAndIndex: DESC }
        ) { ${TX_FIELDS} }
      }`,
      { a: address },
      20_000
    );
    const all = data.getTransactions ?? [];
    const txs = await withTimes(chain, all.slice(0, limit));
    // The indexer caps a result at 10,000 rows, so a full page is a floor.
    return {
      txs,
      total: all.length < 10_000 ? all.length : null,
      failed: false,
      source: "search" as const,
    };
  } catch {
    return { txs: [], total: null, failed: true, source: "search" as const };
  }
}

interface GnoBlockCommit {
  result?: {
    block?: {
      header?: { height?: string };
      last_commit?: {
        precommits?: ({ validator_address?: string } | null)[];
      };
    };
  };
}

/**
 * Signing history over the last N blocks, keyed by the validator's g1 address.
 *
 * gno.land has no slashing module, so there is no long-window uptime to read —
 * the ratio here is measured over these blocks only, and is labelled as such.
 * Absent precommits are null entries, which is what makes a miss visible.
 */
export async function gnoUptime(
  chain: ChainConfig,
  count = RECENT_BAR_COUNT
): Promise<Map<string, ValidatorUptime>> {
  const out = new Map<string, ValidatorUptime>();

  let head: number;
  try {
    const status = await gnoRpc<StatusResult>(chain, "/status");
    head = Number(status.sync_info.latest_block_height);
  } catch {
    return out;
  }
  if (!Number.isFinite(head)) return out;

  const heights = Array.from({ length: count }, (_, i) => head - i)
    .filter((h) => h > 0)
    .reverse();

  const blocks = await Promise.allSettled(
    heights.map((h) =>
      fetchFrom<GnoBlockCommit>(
        chain.rpcEndpoints,
        `/block?height=${h}`,
        { cache: "no-store", timeoutMs: 8000 },
        `${chain.chainId} rpc`,
        chain.fallbackRpcEndpoints
      )
    )
  );

  const perBlock: Set<string>[] = [];
  for (const result of blocks) {
    if (result.status !== "fulfilled") continue;
    const set = new Set<string>();
    for (const pc of result.value.result?.block?.last_commit?.precommits ?? []) {
      if (pc?.validator_address) set.add(pc.validator_address);
    }
    perBlock.push(set);
  }

  const seen = new Set<string>();
  for (const set of perBlock) for (const addr of set) seen.add(addr);

  for (const addr of seen) {
    const bars = perBlock.map((set) => set.has(addr));
    const signed = bars.filter(Boolean).length;
    out.set(addr, {
      ratio: bars.length > 0 ? signed / bars.length : null,
      missed: bars.length - signed,
      window: bars.length,
      bars,
      // gno has no slashing module, so no validator is ever jailed.
      jailedUntil: null,
      tombstoned: false,
    });
  }

  return out;
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
/**
 * How many validators have registered a profile in the valopers realm. This is
 * the registry size, which is larger than the active consensus set — operators
 * register before (or after) they hold a slot in the valset.
 */
export async function gnoRegisteredCount(chain: ChainConfig): Promise<number | null> {
  try {
    const index = await getValoperIndexNow(chain, 40_000);
    return index.byOperator.size > 0 ? index.byOperator.size : null;
  } catch {
    return null;
  }
}

export async function gnoValidatorDetail(
  chain: ChainConfig,
  address: string
): Promise<GnoValidatorDetail | null> {
  prewarmValoperIndex(chain);
  try {
    const [set, monikers] = await Promise.all([
      gnoRpc<ValidatorsResult>(chain, "/validators", { timeoutMs: 12_000 }),
      valoperMonikers(chain),
    ]);
    const ranked = [...set.validators].sort(
      (a, b) => Number(b.voting_power) - Number(a.voting_power)
    );
    const index = ranked.findIndex((v) => v.address === address);
    if (index < 0) return null;

    const hit = ranked[index];
    const total = ranked.reduce((sum, v) => sum + Number(v.voting_power), 0);

    return {
      address: hit.address,
      moniker: monikers.get(hit.address) || null,
      status: "ACTIVE",
      votingPower: hit.voting_power,
      sharePercent: total > 0 ? (Number(hit.voting_power) / total) * 100 : null,
      rank: index + 1,
      // Neither the node nor the tx-indexer records when a validator first
      // signed, and a guess would be a wrong fact on the page.
      firstCommittedHeight: null,
      firstCommittedTime: null,
    };
  } catch {
    return null;
  }
}
