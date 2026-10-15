import { createHash } from "node:crypto";
import type { ChainConfig } from "@/lib/chains";
import { abciQuery } from "@/lib/gno-abci";
import { fetchFrom } from "@/lib/lcd";
import { gnoPartyPage } from "@/lib/indexer-tx";
import { cached } from "@/lib/cache";
import { isNumericId, isBech32ish } from "@/lib/input";
import { RECENT_BAR_COUNT, type ValidatorUptime } from "@/lib/uptime";
import type { ChainOverview } from "@/lib/overview";
import type { BlockSummary } from "@/lib/blocks";
import type { TxSummary, TxMessage, TxEvent } from "@/lib/txs";
import type { DecodedField } from "@/lib/msg-decode";
import { packageHref } from "@/lib/address-route";
import type { ValidatorSummary } from "@/lib/validators";
import { getValoperIndexNow, prewarmValoperIndex } from "@/lib/gno-valopers";
import {
  parseCoinString,
  type AccountView,
  type AccountTxs,
} from "@/lib/accounts";

/*
 * gno.land runs Tendermint2, not the Cosmos SDK. There is no /cosmos/* REST API,
 * no staking module, and the RPC ships with transaction indexing disabled - its
 * /tx_search route 404s. Chain head and the validator set therefore come from
 * JSON-RPC, while blocks and transactions come from our own tx-indexer
 * (gnolang/tx-indexer), which runs beside the node on this box and answers
 * GraphQL. It replaced Onbloc's REST API, which did not follow the network onto
 * gnoland-1 or onyx-1.
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

/**
 * One GraphQL query against the tx-indexer. Values always travel as variables,
 * never spliced into the query text, since heights, hashes and addresses all
 * arrive from the URL.
 *
 * The indexer has no limit argument: a query returns every match, capped at
 * 10,000 rows. Callers bound their queries by height instead.
 */
export async function gql<T>(
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

type IdxPackage = { name: string; path: string } | null;

type IdxMessageValue =
  | { __typename: "BankMsgSend"; from_address: string; to_address: string; amount: string }
  | {
      __typename: "MsgCall";
      caller: string;
      send: string;
      pkg_path: string;
      func: string;
      args: string[] | null;
      max_deposit: string;
    }
  | { __typename: "MsgAddPackage"; creator: string; send: string; max_deposit: string; package: IdxPackage }
  | { __typename: "MsgRun"; caller: string; send: string; max_deposit: string; package: IdxPackage }
  | { __typename: "UnexpectedMessage" };

type IdxEvent =
  | { __typename: "GnoEvent"; type: string; pkg_path: string; attrs: { key: string; value: string }[] | null }
  | {
      __typename: "StorageDepositEvent";
      bytes_delta: number;
      fee_delta: { amount: number; denom: string } | null;
      pkg_path: string;
    }
  | {
      __typename: "StorageUnlockEvent";
      bytes_delta: number;
      fee_refund: { amount: number; denom: string } | null;
      pkg_path: string;
    }
  | { __typename: "UnknownEvent" };

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
  response: { error: string; log: string; events: IdxEvent[] | null } | null;
}

const TX_FIELDS = `hash index block_height success gas_used gas_wanted
  gas_fee { amount denom } memo
  response { error log events {
    __typename
    ... on GnoEvent { type pkg_path attrs { key value } }
    ... on StorageDepositEvent { bytes_delta fee_delta { amount denom } pkg_path }
    ... on StorageUnlockEvent { bytes_delta fee_refund { amount denom } pkg_path }
  } }
  messages { typeUrl route value {
    __typename
    ... on BankMsgSend { from_address to_address amount }
    ... on MsgCall { caller send pkg_path func args max_deposit }
    ... on MsgAddPackage { creator send max_deposit package { name path } }
    ... on MsgRun { caller send max_deposit package { name path } }
  } }`;

/* ------------------------------------------------------------------------
 * Hashes. gno names a transaction by the base64 of its sha256; gnoscan and
 * the node's /tx route use the hex of the same bytes. Both are accepted
 * everywhere and both are shown.
 * --------------------------------------------------------------------- */

/** Base64 transaction hash → uppercase hex. Null when it is not a 32-byte hash. */
export function gnoHashToHex(hash: string): string | null {
  try {
    const bytes = Buffer.from(hash.trim(), "base64");
    return bytes.length === 32 ? bytes.toString("hex").toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Hex transaction hash, with or without 0x → gno's base64 form. */
export function hexToGnoHash(input: string): string | null {
  const hex = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex").toString("base64");
}

/** Either form in, base64 out. Null when the input is neither. */
export function normalizeGnoHash(input: string): string | null {
  const fromHex = hexToGnoHash(input);
  if (fromHex) return fromHex;
  const trimmed = input.trim();
  return gnoHashToHex(trimmed) ? trimmed : null;
}

/* ------------------------------------------------------------------------
 * One transaction shape for both sources. The tx-indexer is the fast path,
 * but it drops some records (block rows list hashes whose transactions answer
 * "item not found in storage"), so every read can fall back to the node,
 * whose raw transaction is decoded below into the same shape.
 * --------------------------------------------------------------------- */

type GnoCoin = { denom: string; amount: string };

/** The package every GRC20 token is built on; it emits their events. */
const GRC20_PACKAGE = "gno.land/p/nt/grc20/v0";

/** A decoded gno message, carried on TxMessage as `gno` for the tx page. */
export interface GnoMessageValue {
  kind: "send" | "call" | "addpkg" | "run" | "other";
  /** "/bank.send", "/vm.exec", "/vm.add_package", "/vm.run". */
  type: string;
  from?: string;
  to?: string;
  amount?: GnoCoin[];
  caller?: string;
  creator?: string;
  send?: GnoCoin[];
  maxDeposit?: GnoCoin[];
  pkgPath?: string;
  pkgName?: string;
  func?: string;
  args?: string[];
}

export interface GnoEventView {
  type: string;
  pkgPath: string | null;
  attrs: { key: string; value: string }[];
}

export interface GnoStorageChange {
  kind: "deposit" | "unlock";
  pkgPath: string | null;
  bytesDelta: number;
  /** Fee locked (deposit) or refunded (unlock). */
  fee: GnoCoin | null;
}

/** A GRC20 transfer: `token` is the token's key, "<realm>.<SYMBOL>.<seq>". */
export interface GnoTokenTransfer {
  token: string;
  from: string | null;
  to: string | null;
  value: string;
}

/** Everything gno-specific about a transaction, carried on the tx as `gno`. */
export interface GnoTxExtras {
  hashHex: string | null;
  /** Where the record came from; "node" means the indexer did not have it. */
  source: "indexer" | "node";
  events: GnoEventView[];
  storage: GnoStorageChange[];
  tokenTransfers: GnoTokenTransfer[];
  /** Coin movements the chain itself reported (bank TransferEvent). */
  bankTransfers: { from: string | null; to: string | null; amount: GnoCoin[] }[];
}

interface GnoTxRecord {
  hash: string;
  index: number;
  height: number;
  success: boolean;
  error: string;
  gasUsed: number | null;
  gasWanted: number | null;
  fee: GnoCoin | null;
  memo: string;
  messages: GnoMessageValue[];
  events: GnoEventView[];
  storage: GnoStorageChange[];
  bankTransfers: GnoTxExtras["bankTransfers"];
  source: "indexer" | "node";
}

const coins = (value: string | null | undefined): GnoCoin[] =>
  value ? parseCoinString(value) : [];

function fromIndexer(tx: IdxTx): GnoTxRecord {
  const messages: GnoMessageValue[] = (tx.messages ?? []).map((m) => {
    const type = `/${m.route}.${m.typeUrl}`;
    const v = m.value;
    switch (v?.__typename) {
      case "BankMsgSend":
        return { kind: "send", type, from: v.from_address, to: v.to_address, amount: coins(v.amount) };
      case "MsgCall":
        return {
          kind: "call",
          type,
          caller: v.caller,
          send: coins(v.send),
          maxDeposit: coins(v.max_deposit),
          pkgPath: v.pkg_path,
          func: v.func,
          args: v.args ?? [],
        };
      case "MsgAddPackage":
        return {
          kind: "addpkg",
          type,
          creator: v.creator,
          send: coins(v.send),
          maxDeposit: coins(v.max_deposit),
          pkgPath: v.package?.path,
          pkgName: v.package?.name,
        };
      case "MsgRun":
        return {
          kind: "run",
          type,
          caller: v.caller,
          send: coins(v.send),
          maxDeposit: coins(v.max_deposit),
          pkgPath: v.package?.path,
          pkgName: v.package?.name,
        };
      default:
        return { kind: "other", type };
    }
  });

  const events: GnoEventView[] = [];
  const storage: GnoStorageChange[] = [];
  for (const e of tx.response?.events ?? []) {
    if (e.__typename === "GnoEvent") {
      events.push({ type: e.type, pkgPath: e.pkg_path || null, attrs: e.attrs ?? [] });
    } else if (e.__typename === "StorageDepositEvent") {
      storage.push({
        kind: "deposit",
        pkgPath: e.pkg_path || null,
        bytesDelta: e.bytes_delta,
        fee: e.fee_delta ? { denom: e.fee_delta.denom, amount: String(e.fee_delta.amount) } : null,
      });
    } else if (e.__typename === "StorageUnlockEvent") {
      storage.push({
        kind: "unlock",
        pkgPath: e.pkg_path || null,
        bytesDelta: e.bytes_delta,
        fee: e.fee_refund ? { denom: e.fee_refund.denom, amount: String(e.fee_refund.amount) } : null,
      });
    }
  }

  return {
    hash: tx.hash,
    index: tx.index ?? 0,
    height: tx.block_height,
    success: tx.success,
    error: tx.response?.error ?? "",
    gasUsed: tx.gas_used ?? null,
    gasWanted: tx.gas_wanted ?? null,
    fee: tx.gas_fee?.amount ? { denom: tx.gas_fee.denom, amount: String(tx.gas_fee.amount) } : null,
    memo: tx.memo ?? "",
    messages,
    events,
    storage,
    // The indexer does not expose bank TransferEvents; sends carry their own parties.
    bankTransfers: [],
    source: "indexer",
  };
}

/* ---- Minimal protobuf reader for the node's raw transaction bytes. gno's
 * amino binary is protobuf-compatible: std.Tx { 1 msgs: Any, 2 fee, 3 sigs,
 * 4 memo }, Any { 1 type_url, 2 value }. Field numbers were checked against
 * the indexer's decoding of the same transactions. */

type PbField = { field: number; wire: number; int?: number; bytes?: Uint8Array };

function readVarint(b: Uint8Array, at: number): [number, number] {
  let value = 0;
  let scale = 1;
  let i = at;
  while (i < b.length) {
    const byte = b[i++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, i];
    scale *= 128;
  }
  throw new Error("truncated varint");
}

function pbFields(b: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < b.length) {
    const [key, next] = readVarint(b, i);
    i = next;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const [v, n] = readVarint(b, i);
      i = n;
      out.push({ field, wire, int: v });
    } else if (wire === 2) {
      const [len, n] = readVarint(b, i);
      i = n;
      out.push({ field, wire, bytes: b.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

const utf8 = (b?: Uint8Array) => (b ? Buffer.from(b).toString("utf8") : "");

function pbStrings(fields: PbField[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const f of fields) {
    if (f.wire !== 2) continue;
    const list = map.get(f.field) ?? [];
    list.push(utf8(f.bytes));
    map.set(f.field, list);
  }
  return map;
}

function decodePackage(bytes?: Uint8Array): { name?: string; path?: string } {
  if (!bytes) return {};
  const s = pbStrings(pbFields(bytes));
  return { name: s.get(1)?.[0], path: s.get(2)?.[0] };
}

function decodeMessage(typeUrl: string, value?: Uint8Array): GnoMessageValue {
  const fields = value ? pbFields(value) : [];
  const s = pbStrings(fields);
  const one = (n: number) => s.get(n)?.[0] || undefined;
  const bytesOf = (n: number) => fields.find((f) => f.field === n && f.wire === 2)?.bytes;
  switch (typeUrl) {
    case "/bank.MsgSend":
      return { kind: "send", type: "/bank.send", from: one(1), to: one(2), amount: coins(one(3)) };
    case "/vm.m_call":
      return {
        kind: "call",
        type: "/vm.exec",
        caller: one(1),
        send: coins(one(2)),
        maxDeposit: coins(one(3)),
        pkgPath: one(4),
        func: one(5),
        args: s.get(6) ?? [],
      };
    case "/vm.m_addpkg": {
      const pkg = decodePackage(bytesOf(2));
      return {
        kind: "addpkg",
        type: "/vm.add_package",
        creator: one(1),
        send: coins(one(3)),
        maxDeposit: coins(one(4)),
        pkgPath: pkg.path,
        pkgName: pkg.name,
      };
    }
    case "/vm.m_run": {
      const pkg = decodePackage(bytesOf(3));
      return {
        kind: "run",
        type: "/vm.run",
        caller: one(1),
        send: coins(one(2)),
        maxDeposit: coins(one(4)),
        pkgPath: pkg.path,
        pkgName: pkg.name,
      };
    }
    default:
      return { kind: "other", type: typeUrl };
  }
}

/** Decode a base64 std.Tx: its messages, fee and memo. Exported for tests. */
export function decodeGnoTx(txBase64: string): {
  messages: GnoMessageValue[];
  gasWanted: number | null;
  fee: GnoCoin | null;
  memo: string;
} {
  const top = pbFields(Buffer.from(txBase64, "base64"));
  const messages: GnoMessageValue[] = [];
  let gasWanted: number | null = null;
  let fee: GnoCoin | null = null;
  let memo = "";
  for (const f of top) {
    if (f.field === 1 && f.bytes) {
      const any = pbFields(f.bytes);
      const typeUrl = utf8(any.find((x) => x.field === 1)?.bytes);
      messages.push(decodeMessage(typeUrl, any.find((x) => x.field === 2)?.bytes));
    } else if (f.field === 2 && f.bytes) {
      const feeFields = pbFields(f.bytes);
      gasWanted = feeFields.find((x) => x.field === 1)?.int ?? null;
      fee = coins(utf8(feeFields.find((x) => x.field === 2)?.bytes))[0] ?? null;
    } else if (f.field === 4 && f.bytes) {
      memo = utf8(f.bytes);
    }
  }
  return { messages, gasWanted, fee, memo };
}

/** The node's /tx result, as served by gno.land's TM2 RPC. */
export interface GnoNodeTx {
  hash: string;
  height: string;
  index: number;
  tx: string;
  tx_result: {
    ResponseBase: {
      Error: unknown;
      Events: Record<string, unknown>[] | null;
      Log: string;
    };
    GasWanted: string;
    GasUsed: string;
  };
}

/** Map the node's record onto the shared shape. Exported for tests. */
export function fromNodeTx(node: GnoNodeTx): GnoTxRecord {
  const decoded = decodeGnoTx(node.tx);
  const base = node.tx_result.ResponseBase;
  const events: GnoEventView[] = [];
  const storage: GnoStorageChange[] = [];
  const bankTransfers: GnoTxExtras["bankTransfers"] = [];
  for (const raw of base.Events ?? []) {
    const type = String(raw["@type"] ?? "");
    const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : null);
    if (type.endsWith("TransferEvent")) {
      bankTransfers.push({ from: str("from"), to: str("to"), amount: coins(str("coins")) });
    } else if (type.endsWith("StorageDepositEvent") || type.endsWith("StorageUnlockEvent")) {
      const deposit = type.endsWith("StorageDepositEvent");
      storage.push({
        kind: deposit ? "deposit" : "unlock",
        pkgPath: str("pkg_path"),
        bytesDelta: Number(raw.bytes_delta ?? 0),
        fee: coins(str(deposit ? "fee_delta" : "fee_refund"))[0] ?? null,
      });
    } else if (Array.isArray(raw.attrs) || str("type")) {
      events.push({
        type: str("type") ?? type,
        pkgPath: str("pkg_path"),
        attrs: Array.isArray(raw.attrs) ? (raw.attrs as { key: string; value: string }[]) : [],
      });
    }
  }
  const failed = base.Error !== null && base.Error !== undefined;
  return {
    hash: node.hash,
    index: node.index ?? 0,
    height: Number(node.height),
    success: !failed,
    error: failed ? base.Log || JSON.stringify(base.Error) : "",
    gasUsed: Number(node.tx_result.GasUsed) || null,
    gasWanted: Number(node.tx_result.GasWanted) || decoded.gasWanted,
    fee: decoded.fee,
    memo: decoded.memo,
    messages: decoded.messages,
    events,
    storage,
    bankTransfers,
    source: "node",
  };
}

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

function labelFor(m: GnoMessageValue): string {
  switch (m.kind) {
    case "send":
      return "Send";
    case "call":
      return m.func || "Call";
    case "addpkg":
      return "Add package";
    case "run":
      return "Run";
    default:
      return labelForGnoMessage({ messageType: m.type, funcType: "", pkgPath: "" });
  }
}

/** Parties and amount for the shared list views. Exported for tests. */
export function gnoMessageTransfer(m: GnoMessageValue): TxMessage["transfer"] {
  switch (m.kind) {
    case "send":
      return { from: m.from ?? null, to: m.to ?? null, amount: m.amount ?? [], staking: false };
    case "call":
    case "run":
      return m.caller ? { from: m.caller, to: null, amount: m.send ?? [], staking: false } : null;
    case "addpkg":
      return m.creator ? { from: m.creator, to: null, amount: m.send ?? [], staking: false } : null;
    default:
      return null;
  }
}

export type GnoTxMessage = TxMessage & { gno: GnoMessageValue };
export type GnoTxSummary = TxSummary & { messages: GnoTxMessage[]; gno: GnoTxExtras };

/**
 * A message's details for the transaction page: the realm called and with
 * what, or the package deployed. A plain send keeps the shared From, To and
 * Amount rows.
 */
export function gnoMessageFields(chainId: string, m: GnoMessageValue): DecodedField[] {
  const coins = (label: string, c?: GnoCoin[]): DecodedField[] =>
    c && c.length ? [{ label, value: { kind: "coins", coins: c } }] : [];
  const pkg = (label: string): DecodedField[] =>
    m.pkgPath
      ? [{ label, value: { kind: "link", href: packageHref(chainId, m.pkgPath), text: m.pkgPath, mono: true } }]
      : [];
  switch (m.kind) {
    case "call":
      return [
        ...pkg("Realm"),
        ...(m.func ? [{ label: "Function", value: { kind: "text" as const, text: m.func, mono: true } }] : []),
        ...(m.args?.length
          ? [{ label: "Arguments", value: { kind: "json" as const, json: m.args.map((a) => JSON.stringify(a)).join("\n") } }]
          : []),
        ...(m.caller ? [{ label: "Caller", value: { kind: "address" as const, address: m.caller } }] : []),
        ...coins("Sent", m.send),
        ...coins("Max deposit", m.maxDeposit),
      ];
    case "addpkg":
      return [
        ...pkg("Package"),
        ...(m.creator ? [{ label: "Creator", value: { kind: "address" as const, address: m.creator } }] : []),
        ...coins("Sent", m.send),
        ...coins("Max deposit", m.maxDeposit),
      ];
    case "run":
      return [
        ...(m.caller ? [{ label: "Caller", value: { kind: "address" as const, address: m.caller } }] : []),
        ...coins("Sent", m.send),
        ...coins("Max deposit", m.maxDeposit),
      ];
    default:
      return [];
  }
}

/**
 * Every event for the transaction page's Events tab, each with the package
 * that emitted it; gno does not say which message emitted an event.
 */
function eventsOf(rec: GnoTxRecord): TxEvent[] {
  return [
    ...rec.events.map((e) => ({
      type: e.type,
      attributes: [...(e.pkgPath ? [{ key: "pkg_path", value: e.pkgPath }] : []), ...e.attrs],
      msgIndex: null,
    })),
    ...rec.storage.map((st) => ({
      type: st.kind === "deposit" ? "StorageDeposit" : "StorageUnlock",
      attributes: [
        ...(st.pkgPath ? [{ key: "pkg_path", value: st.pkgPath }] : []),
        { key: "bytes_delta", value: String(st.bytesDelta) },
        ...(st.fee ? [{ key: st.kind === "deposit" ? "fee_delta" : "fee_refund", value: `${st.fee.amount}${st.fee.denom}` }] : []),
      ],
      msgIndex: null,
    })),
  ];
}

function toTxSummary(chainId: string, rec: GnoTxRecord, time: string | null): GnoTxSummary {
  const messages: GnoTxMessage[] = rec.messages.map((m) => ({
    // A realm call keeps its path in the type, as the list has always shown it.
    typeUrl: m.kind === "call" && m.pkgPath ? `${m.type} ${m.pkgPath}` : m.type,
    label: labelFor(m),
    transfer: gnoMessageTransfer(m),
    fields: gnoMessageFields(chainId, m),
    gno: m,
  }));

  // GRC20 transfers: the grc20 package's own Transfer events, which name the
  // token by its key. A token realm often emits its own Transfer beside it.
  const tokenTransfers: GnoTokenTransfer[] = rec.events
    .filter((e) => e.type === "Transfer" && e.pkgPath === GRC20_PACKAGE)
    .flatMap((e) => {
      const get = (k: string) => e.attrs.find((a) => a.key === k)?.value ?? null;
      const token = get("token");
      return token ? [{ token, from: get("from"), to: get("to"), value: get("value") ?? "" }] : [];
    });

  // One line for list views: the first message that moved coins, else the
  // chain's own transfer event, else the first message with a party.
  const moved = messages.find((m) => (m.transfer?.amount.length ?? 0) > 0)?.transfer;
  const bank = rec.bankTransfers[0];
  const transfer =
    moved ??
    (bank ? { from: bank.from, to: bank.to, amount: bank.amount, staking: false } : null) ??
    messages.find((m) => m.transfer)?.transfer ??
    null;

  return {
    hash: rec.hash,
    height: String(rec.height),
    time,
    // Map onto the ABCI convention where 0 means success so the shared UI can
    // render it unchanged.
    code: rec.success ? 0 : 1,
    messages,
    messageCount: messages.length,
    transfer,
    fee: rec.fee ? [rec.fee] : [],
    gasUsed: rec.gasUsed ? String(rec.gasUsed) : null,
    gasWanted: rec.gasWanted ? String(rec.gasWanted) : null,
    memo: rec.memo,
    gno: {
      hashHex: gnoHashToHex(rec.hash),
      source: rec.source,
      events: rec.events,
      storage: rec.storage,
      tokenTransfers,
      bankTransfers: rec.bankTransfers,
    },
  };
}

/* ---- Fetching. Committed blocks and transactions never change, so each is
 * cached by height or hash for half an hour; only the head moves. */

const FINAL_TTL = 30 * 60_000;

/** One block's time. An equality lookup is ~1 ms; an `_or` over heights is a scan. */
function blockTime(chain: ChainConfig, height: number): Promise<string | null> {
  return cached(`gno-btime:${chain.chainId}:${height}`, FINAL_TTL, async () => {
    try {
      const data = await gql<{ getBlocks: { time: string }[] | null }>(
        chain,
        `query($h: Int!) { getBlocks(where: { height: { eq: $h } }) { time } }`,
        { h: height },
        5000
      );
      const t = data.getBlocks?.[0]?.time;
      if (t) return t;
    } catch {
      // fall through to the node
    }
    const res = await gnoRpc<{ block_meta?: { header?: { time?: string } } }>(
      chain,
      `/block?height=${height}`
    ).catch(() => null);
    return res?.block_meta?.header?.time ?? null;
  });
}

/** Block times for a set of heights, looked up in parallel and bounded. */
async function blockTimes(chain: ChainConfig, heights: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(heights)];
  const out = new Map<number, string>();
  await mapLimit(unique, 10, async (h) => {
    const t = await blockTime(chain, h).catch(() => null);
    if (t) out.set(h, t);
  });
  return out;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Transactions the indexer holds at one height. */
function indexedTxsAt(chain: ChainConfig, height: number): Promise<IdxTx[]> {
  return cached(`gno-htxs:${chain.chainId}:${height}`, FINAL_TTL, async () => {
    const data = await gql<{ getTransactions: IdxTx[] | null }>(
      chain,
      `query($h: Int!) { getTransactions(where: { block_height: { eq: $h } }, order: { heightAndIndex: ASC }) { ${TX_FIELDS} } }`,
      { h: height }
    );
    return data.getTransactions ?? [];
  }, { group: { name: "gno-block-txs", max: 300 } });
}

/** Only successful node reads are cached; a miss is retried next time. */
const nodeTxCache = new Map<string, { at: number; value: GnoNodeTx }>();

/** One transaction from the node. Null when the node says it has none. */
async function nodeTx(chain: ChainConfig, hash: string): Promise<GnoNodeTx | null> {
  const key = `${chain.chainId}:${hash}`;
  const hit = nodeTxCache.get(key);
  if (hit && Date.now() - hit.at < FINAL_TTL) return hit.value;
  const hex = gnoHashToHex(hash);
  if (!hex) return null;
  try {
    const value = await gnoRpc<GnoNodeTx>(chain, `/tx?hash=0x${hex}`, { timeoutMs: 8000 });
    if (nodeTxCache.size > 2000) nodeTxCache.clear();
    nodeTxCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (/could not find|not found/i.test(String((err as Error)?.message ?? err))) return null;
    throw err;
  }
}

/** Hashes a block contains, from the indexer's block row or else the node. */
function blockTxHashes(chain: ChainConfig, height: number): Promise<string[]> {
  return cached(`gno-bhashes:${chain.chainId}:${height}`, FINAL_TTL, async () => {
    try {
      const data = await gql<{ getBlocks: { txs: { hash: string }[] | null }[] | null }>(
        chain,
        `query($h: Int!) { getBlocks(where: { height: { eq: $h } }) { txs { hash } } }`,
        { h: height },
        5000
      );
      const block = data.getBlocks?.[0];
      if (block) return (block.txs ?? []).map((t) => t.hash);
    } catch {
      // fall through to the node
    }
    const res = await gnoRpc<{ block?: { data?: { txs?: string[] | null } } }>(
      chain,
      `/block?height=${height}`
    );
    return (res.block?.data?.txs ?? []).map((raw) =>
      createHash("sha256").update(Buffer.from(raw, "base64")).digest("base64")
    );
  });
}

/**
 * Resolve transactions by (hash, height): the indexer first, the node for any
 * hash the indexer does not hold. Order follows `refs`.
 */
async function resolveTxs(
  chain: ChainConfig,
  refs: { hash: string; height: number }[]
): Promise<GnoTxRecord[]> {
  const heights = [...new Set(refs.map((r) => r.height))];
  const byHash = new Map<string, GnoTxRecord>();
  await mapLimit(heights, 8, async (h) => {
    const txs = await indexedTxsAt(chain, h).catch(() => [] as IdxTx[]);
    for (const tx of txs) byHash.set(tx.hash, fromIndexer(tx));
  });

  const missing = refs.filter((r) => !byHash.has(r.hash));
  await mapLimit(missing, 6, async (r) => {
    const node = await nodeTx(chain, r.hash).catch(() => null);
    if (node) byHash.set(r.hash, fromNodeTx(node));
  });

  return refs.flatMap((r) => {
    const rec = byHash.get(r.hash);
    return rec ? [rec] : [];
  });
}

async function withTimes(chain: ChainConfig, recs: GnoTxRecord[]): Promise<GnoTxSummary[]> {
  const times = await blockTimes(
    chain,
    recs.map((r) => r.height)
  );
  return recs.map((r) => toTxSummary(chain.chainId, r, times.get(r.height) ?? null));
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

/**
 * The proposer is kept as its signing address, which is also the id of its
 * validator page, so it can be linked; the name travels beside it.
 */
function toBlockSummary(
  block: IdxBlock,
  names: Map<string, string>
): BlockSummary & { proposerMoniker: string | null; proposerOperator: string | null } {
  return {
    height: String(block.height),
    time: block.time,
    txCount: block.num_txs ?? 0,
    proposer: block.proposer_address_raw,
    proposerMoniker: names.get(block.proposer_address_raw) ?? null,
    proposerOperator: block.proposer_address_raw || null,
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
    // report here. Left null so the UI renders "-" rather than a fabricated 0.
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
  proposerMoniker: string | null;
  /** The proposer's validator page id (its signing address). */
  proposerOperator: string | null;
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
  try {
    const data = await gql<{ getBlocks: IdxBlock[] | null }>(
      chain,
      `query($h: Int!) { getBlocks(where: { height: { eq: $h } }) { ${BLOCK_FIELDS} } }`,
      { h }
    );
    block = data.getBlocks?.[0];
  } catch {
    return null;
  }
  if (!block) return null;

  // Gas and fees are summed over every transaction the block holds, including
  // any the indexer is missing and the node supplies.
  const [names, txs] = await Promise.all([
    proposerNames(chain),
    blockRecords(chain, h).catch(() => [] as GnoTxRecord[]),
  ]);
  const sum = (pick: (t: GnoTxRecord) => number | null) =>
    txs.reduce((acc, t) => acc + (pick(t) || 0), 0);
  const gasUsed = sum((t) => t.gasUsed);
  const gasWanted = sum((t) => t.gasWanted);
  const fees = sum((t) => (t.fee ? Number(t.fee.amount) : 0));

  return {
    height: String(block.height),
    time: block.time,
    txCount: block.num_txs ?? 0,
    proposer: block.proposer_address_raw,
    hash: block.hash,
    chainId: block.chain_id || null,
    proposerLabel: names.get(block.proposer_address_raw) ?? null,
    proposerMoniker: names.get(block.proposer_address_raw) ?? null,
    proposerOperator: block.proposer_address_raw || null,
    gasUsed: gasUsed ? String(gasUsed) : null,
    gasWanted: gasWanted ? String(gasWanted) : null,
    totalFees: fees ? String(fees) : null,
  };
}

/** Every transaction in a block, from the indexer or, where it has none, the node. */
async function blockRecords(chain: ChainConfig, height: number): Promise<GnoTxRecord[]> {
  const hashes = await blockTxHashes(chain, height);
  return resolveTxs(
    chain,
    hashes.map((hash) => ({ hash, height }))
  );
}

/**
 * The transactions in one block. Throws when neither the indexer nor the node
 * can say what the block holds, so the page can tell an outage from an empty
 * block.
 */
export async function gnoBlockTxs(
  chain: ChainConfig,
  height: string | number
): Promise<GnoTxSummary[]> {
  if (!isNumericId(height)) return [];
  const recs = await blockRecords(chain, Number(height));
  return withTimes(chain, recs);
}

/**
 * Transactions are sparse on gno - a quiet testnet can go ten thousand blocks
 * without one - so look back in widening windows over blocks that hold any,
 * and stop at the first window with enough. Block rows list every hash even
 * where the indexer lost the transaction itself, so nothing is skipped; the
 * transactions are then resolved from the indexer or the node. The widest
 * window is capped: past it the list shows what it found rather than scanning
 * the whole chain on every poll.
 */
const TX_WINDOWS = [2_000, 20_000, 100_000];

async function recentTxRefs(
  chain: ChainConfig,
  count: number
): Promise<{ head: number | null; refs: { hash: string; height: number }[] }> {
  let head: number | null = null;
  try {
    head = (await gql<{ latestBlockHeight: number }>(chain, "{ latestBlockHeight }"))
      .latestBlockHeight;
  } catch {
    head = await headHeight(chain).catch(() => null);
  }
  if (head === null) return { head: null, refs: [] };

  let refs: { hash: string; height: number }[] = [];
  for (const window of TX_WINDOWS) {
    try {
      const data = await gql<{ getBlocks: { height: number; txs: { hash: string }[] | null }[] | null }>(
        chain,
        `query($h: Int!) { getBlocks(where: { height: { gt: $h }, num_txs: { gt: 0 } }, order: { height: DESC }) { height txs { hash } } }`,
        { h: Math.max(0, head - window) },
        15_000
      );
      refs = (data.getBlocks ?? []).flatMap((b) =>
        [...(b.txs ?? [])].reverse().map((t) => ({ hash: t.hash, height: b.height }))
      );
    } catch {
      // The indexer caps a result at 10,000 rows; keep what the smaller window held.
      break;
    }
    if (refs.length >= count) break;
  }
  return { head, refs: refs.slice(0, count) };
}

export async function gnoRecentTxs(
  chain: ChainConfig,
  count = 30
): Promise<{ txs: GnoTxSummary[]; scannedBlocks: number; headHeight: string | null }> {
  // The feed is polled every few seconds; the window scan is shared and
  // refreshed in the background.
  const { head, refs } = await cached(
    `gno-recent-refs:${chain.chainId}:${count}`,
    5_000,
    () => recentTxRefs(chain, count),
    { staleMs: 60_000 }
  );
  if (head === null) return { txs: [], scannedBlocks: 0, headHeight: null };
  const recs = await resolveTxs(chain, refs);
  return { txs: await withTimes(chain, recs), scannedBlocks: 0, headHeight: String(head) };
}

/**
 * A single transaction by hash, in either form (base64 or hex, with or
 * without 0x): the indexer first, the node when the indexer lacks it. Null
 * when neither has it; throws when neither could be asked.
 */
export async function gnoTx(
  chain: ChainConfig,
  hashInput: string
): Promise<(GnoTxSummary & { rawLog: string; events: TxEvent[] }) | null> {
  const hash = normalizeGnoHash(hashInput);
  if (!hash) return null;

  let rec: GnoTxRecord | null = null;
  let indexerError: unknown = null;
  try {
    const data = await gql<{ getTransactions: IdxTx[] | null }>(
      chain,
      `query($h: String!) { getTransactions(where: { hash: { eq: $h } }) { ${TX_FIELDS} } }`,
      { h: hash }
    );
    const tx = data.getTransactions?.[0];
    if (tx) rec = fromIndexer(tx);
  } catch (err) {
    // "item not found in storage" is the indexer's way of saying it lost the
    // record; anything else is an outage. Either way, ask the node.
    if (!/not found/i.test(String((err as Error)?.message ?? err))) indexerError = err;
  }

  if (!rec) {
    try {
      const node = await nodeTx(chain, hash);
      if (node) rec = fromNodeTx(node);
    } catch (err) {
      if (indexerError) throw err;
    }
  }
  if (!rec) return null;

  const [summary] = await withTimes(chain, [rec]);
  return { ...summary, rawLog: rec.error, events: eventsOf(rec) };
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
 * "Voting power" is raw Tendermint power - gno.land has no staking module, so
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

  const res = await abciQuery(chain, `auth/accounts/${address}`);
  const raw = res.ok ? res.data : null;
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
 * that names an address - a bank send either way, a realm call or run by it,
 * a package it deployed.
 */
export async function gnoAccountTxs(
  chain: ChainConfig,
  address: string,
  limit = 50,
  cursor?: string | null
): Promise<AccountTxs> {
  // gno addresses are bech32 like any other; same gate, same reason.
  if (!isBech32ish(address))
    return { txs: [], total: 0, failed: false, source: "search" as const };

  // Our own index first (gno_tx_party): exact order and paging at any depth.
  // It lists the page; the details of exactly those transactions come from
  // one tx-indexer query bounded by the page's heights, and the node covers
  // any the tx-indexer lacks.
  if (!cursor || cursor.startsWith("g4:")) {
    const idx = await gnoPartyPage(chain.chainId, address, cursor, limit);
    if (idx) {
      const wanted = new Map(
        idx.rows.map((r) => [hexToGnoHash(r.hash) ?? r.hash, r] as const)
      );
      const recs = new Map<string, GnoTxRecord>();
      if (idx.rows.length > 0) {
        const hi = idx.rows[0].height;
        const lo = idx.rows[idx.rows.length - 1].height;
        try {
          const data = await gql<{ getTransactions: IdxTx[] | null }>(
            chain,
            `query($a: String!, $lo: Int!, $hi: Int!) {
              getTransactions(
                where: { _and: [
                  { block_height: { gt: $lo, lt: $hi } },
                  { messages: { value: { _or: [
                    { BankMsgSend: { _or: [{ from_address: { eq: $a } }, { to_address: { eq: $a } }] } },
                    { MsgCall: { caller: { eq: $a } } },
                    { MsgRun: { caller: { eq: $a } } },
                    { MsgAddPackage: { creator: { eq: $a } } }
                  ] } } }
                ] }
                order: { heightAndIndex: DESC }
              ) { ${TX_FIELDS} }
            }`,
            { a: address, lo: lo - 1, hi: hi + 1 },
            15_000
          );
          for (const tx of data.getTransactions ?? []) {
            if (wanted.has(tx.hash)) recs.set(tx.hash, fromIndexer(tx));
          }
        } catch {
          // The node below fills whatever this could not.
        }
        // Parties the message filter cannot see (a GRC20 Transfer's recipient,
        // a realm receiving coins) and anything the tx-indexer lost.
        await Promise.all(
          [...wanted.keys()]
            .filter((h) => !recs.has(h))
            .map(async (h) => {
              const node = await nodeTx(chain, h).catch(() => null);
              if (node) recs.set(h, fromNodeTx(node));
            })
        );
      }
      const ordered = [...wanted.keys()]
        .map((h) => recs.get(h))
        .filter((r): r is GnoTxRecord => Boolean(r));
      return {
        txs: await withTimes(chain, ordered),
        total: null,
        failed: false,
        source: "indexer" as const,
        more: idx.next !== null,
        next: idx.next,
      };
    }
  }

  // The tx-indexer has no limit or paging, and a busy account has tens of
  // thousands of transactions: asking for all of them at once times out. So
  // walk back from the head (or the cursor's height) in height windows, newest
  // first, widening while pages come back thin, and stop at a full page.
  try {
    const below = cursor?.startsWith("p:") && Number(cursor.slice(2)) > 0
      ? Number(cursor.slice(2))
      : (await gql<{ latestBlockHeight: number }>(chain, `{ latestBlockHeight }`, {}, 8_000))
          .latestBlockHeight + 1;

    const found: IdxTx[] = [];
    let hi = below; // exclusive
    let span = 2_000;
    while (hi > 1 && found.length < limit) {
      const lo = Math.max(0, hi - span); // exclusive
      const data = await gql<{ getTransactions: IdxTx[] | null }>(
        chain,
        `query($a: String!, $lo: Int!, $hi: Int!) {
          getTransactions(
            where: { _and: [
              { block_height: { gt: $lo, lt: $hi } },
              { messages: { value: { _or: [
                { BankMsgSend: { _or: [{ from_address: { eq: $a } }, { to_address: { eq: $a } }] } },
                { MsgCall: { caller: { eq: $a } } },
                { MsgRun: { caller: { eq: $a } } },
                { MsgAddPackage: { creator: { eq: $a } } }
              ] } } }
            ] }
            order: { heightAndIndex: DESC }
          ) { ${TX_FIELDS} }
        }`,
        { a: address, lo, hi },
        15_000
      );
      found.push(...(data.getTransactions ?? []));
      hi = lo + 1;
      if (lo === 0) break;
      // Thin pages widen the window; a full one keeps it.
      if (found.length < limit) span = Math.min(span * 2, 200_000);
    }

    // Keep whole heights: never split a block's transactions across pages.
    let page = found.slice(0, limit);
    if (found.length > limit) {
      const edge = Number(page[page.length - 1].block_height);
      page = found.filter((t, k) => k < limit || Number(t.block_height) === edge);
    }
    const lowest = page.length > 0 ? Number(page[page.length - 1].block_height) : 0;
    const more = found.length > page.length || hi > 1;

    // Times come from per-height lookups (an `_or` across 50 heights timed out
    // and left every row without a time).
    const txs = await withTimes(chain, page.map(fromIndexer));
    return {
      txs,
      total: null,
      failed: false,
      source: "search" as const,
      more,
      next: more && lowest > 1 ? `p:${lowest}` : null,
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
 * gno.land has no slashing module, so there is no long-window uptime to read -
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
}

/**
 * A validator page id from either address a gno operator has: the signing
 * address (the page id, and what blocks name as proposer) or the operator
 * address its valopers profile is registered under. Null when neither is known.
 */
export async function resolveGnoValidatorAddress(
  chain: ChainConfig,
  address: string
): Promise<string | null> {
  try {
    const index = await getValoperIndexNow(chain, 3000);
    if (index.bySigning.has(address)) return address;
    return index.byOperator.get(address)?.signingAddress ?? null;
  } catch {
    return null;
  }
}

/**
 * Registered validators outside the active consensus set: valopers profiles
 * whose signing address holds no voting power right now. Each is keyed by its
 * signing address when it registered one, so its page resolves like any other.
 */
export async function gnoInactiveValidators(chain: ChainConfig): Promise<ValidatorSummary[]> {
  const [set, index] = await Promise.all([
    gnoRpc<ValidatorsResult>(chain, "/validators", { timeoutMs: 12_000 }),
    getValoperIndexNow(chain, 5000),
  ]);
  const active = new Set(set.validators.map((v) => v.address));
  const profiles = [...index.byOperator.values()]
    .filter((p) => !p.signingAddress || !active.has(p.signingAddress))
    .sort((a, b) => (a.moniker || "").localeCompare(b.moniker || ""));
  return profiles.map((p, i) => ({
    rank: i + 1,
    operatorAddress: p.signingAddress ?? p.operatorAddress,
    moniker: p.moniker || p.operatorAddress,
    consensusPubkey: null,
    website: "",
    jailed: false,
    status: "INACTIVE",
    tokens: "0",
    votingPower: 0,
    cumulativePower: 0,
    commissionRate: 0,
  }));
}

/** How many validators have registered a profile in the valopers realm. */
export async function gnoRegisteredCount(chain: ChainConfig): Promise<number | null> {
  try {
    const index = await getValoperIndexNow(chain, 40_000);
    return index.byOperator.size > 0 ? index.byOperator.size : null;
  } catch {
    return null;
  }
}

/**
 * Consensus-side facts about one validator. Accepts the operator address too,
 * resolving it to the signing address; a registered validator outside the set
 * comes back as Inactive rather than as not found.
 */
export async function gnoValidatorDetail(
  chain: ChainConfig,
  address: string
): Promise<GnoValidatorDetail | null> {
  prewarmValoperIndex(chain);
  try {
    const signing = (await resolveGnoValidatorAddress(chain, address)) ?? address;
    const [set, monikers] = await Promise.all([
      gnoRpc<ValidatorsResult>(chain, "/validators", { timeoutMs: 12_000 }),
      valoperMonikers(chain),
    ]);
    const ranked = [...set.validators].sort(
      (a, b) => Number(b.voting_power) - Number(a.voting_power)
    );
    const index = ranked.findIndex((v) => v.address === signing);
    if (index < 0) {
      const moniker = monikers.get(signing) ?? null;
      if (!moniker) return null;
      return { address: signing, moniker, status: "INACTIVE", votingPower: "0", sharePercent: 0, rank: null };
    }

    const hit = ranked[index];
    const total = ranked.reduce((sum, v) => sum + Number(v.voting_power), 0);
    return {
      address: hit.address,
      moniker: monikers.get(hit.address) || null,
      status: "ACTIVE",
      votingPower: hit.voting_power,
      sharePercent: total > 0 ? (Number(hit.voting_power) / total) * 100 : null,
      rank: index + 1,
    };
  } catch {
    return null;
  }
}
