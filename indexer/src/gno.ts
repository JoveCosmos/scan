/**
 * gno.land: blocks, transactions and who each transaction touched.
 *
 * gno is not a Cosmos SDK chain. Its transactions are amino, its events are
 * realm-defined, and there is no /block_results worth parsing by hand. The
 * upstream tx-indexer already decodes all of it, keeps it by height and serves
 * it over GraphQL on this box (one per chain), so this module reads it by
 * height range and projects what Scan needs into the same database as every
 * other chain:
 *
 *   gno_tx        one row per transaction, time from its block
 *   gno_tx_party  one row per (address, transaction), roles as a bitmask -
 *                 the same design as tx_party, so an account's history is a
 *                 keyset walk of one primary key
 *   gno_tx_msg    one row per message: kind, package, function, caller, args
 *   gno_grc20_*   tokens, transfers and (kept by the database) balances, from
 *                 the events gno.land/p/nt/grc20/v0 emits
 *   block         the chain's spine, stamped GNO_EXTRACT_VERSION, so coverage
 *                 works exactly as for Cosmos chains
 *
 * The tx-indexer has dropped records before (an amino type it could not decode,
 * fixed 2026-09-26). A block whose transaction count does not match what the
 * tx-indexer returns for it is written hollow (version 0): present, never
 * claimed as covered.
 */

/**
 *   4  gno_tx, gno_tx_party
 *   5  + gno_tx_msg, GRC20 tokens and transfers (2026-10-16)
 */
export const GNO_EXTRACT_VERSION = 5;

/** Bits shared with tx_party where they mean the same thing; creator is gno's own. */
export const GNO_ROLE = {
  signer: 1,
  sender: 8,
  recipient: 16,
  other: 8192,
  creator: 16384,
} as const;

export const GNO_BLOCK_FIELDS = "hash height time num_txs chain_id";
/* What each message and event type contributes. A tx-indexer built from an older gno knows
   fewer of them (pearl-1's has no package approval and no bank TransferEvent), and GraphQL
   rejects a fragment on a type it does not know - so the query names only the types the
   source reports (GnoSource.init). */
const MSG_FRAGS: Record<string, string> = {
  BankMsgSend: "from_address to_address amount",
  MsgCall: "caller send pkg_path func",
  MsgAddPackage: "creator package{ path }",
  MsgRun: "caller send",
  MsgEnablePackage: "approver pkg_path",
  MsgRejectPackage: "sender pkg_path",
};
const EVENT_FRAGS: Record<string, string> = {
  GnoEvent: "type pkg_path attrs{ key value }",
  TransferEvent: "from to coins",
};
/* Fields asked for only where the tx-indexer's schema lists them on the type. */
const MSG_EXTRA: Record<string, Record<string, string>> = {
  MsgCall: { args: "args" },
  MsgRun: { package: "package{ path }" },
};
export function gnoTxFields(msgTypes: string[], eventTypes: string[], fields: Record<string, string[]> = {}): string {
  const frag = (t: string) =>
    [MSG_FRAGS[t], ...Object.entries(MSG_EXTRA[t] ?? {}).filter(([f]) => fields[t]?.includes(f)).map(([, sel]) => sel)].join(" ");
  const m = msgTypes.filter((t) => MSG_FRAGS[t]).map((t) => `... on ${t}{ ${frag(t)} }`).join(" ");
  const e = eventTypes.filter((t) => EVENT_FRAGS[t]).map((t) => `... on ${t}{ ${EVENT_FRAGS[t]} }`).join(" ");
  return `index hash success block_height gas_wanted gas_used memo gas_fee{ amount denom }
  messages{ typeUrl route value{ __typename ${m} } }
  response{ error events{ __typename ${e} } }`;
}

export interface GnoBlockIn {
  hash: string;
  height: number;
  time: string;
  num_txs: number;
  chain_id: string;
}

interface Attr { key: string; value: string }
export interface GnoTxIn {
  index: number;
  hash: string;
  success: boolean;
  block_height: number;
  gas_wanted: number | null;
  gas_used: number | null;
  memo: string | null;
  gas_fee: { amount: number | string | null; denom: string | null } | null;
  messages: { typeUrl: string; route: string; value: Record<string, unknown> & { __typename: string } }[] | null;
  response: {
    error: string | null;
    events: ({ __typename: string; type?: string; pkg_path?: string; attrs?: Attr[] | null; from?: string; to?: string })[] | null;
  } | null;
}

export interface GnoBlockRow { height: string; time: string; hash: string | null; txCount: number; version: number }
export interface GnoTxRow {
  hash: string;
  height: string;
  txIndex: number;
  time: string;
  success: boolean;
  gasWanted: string | null;
  gasUsed: string | null;
  feeAmount: string | null;
  feeDenom: string | null;
  msgTypes: string[];
  memo: string;
  error: string | null;
}
export interface GnoPartyRow { address: string; height: string; txHash: string; roles: number }
/** kind: call, run, addpkg, enable, reject, send. msgIndex is the message's place in the transaction. */
export interface GnoMsgRow {
  txHash: string;
  msgIndex: number;
  height: string;
  success: boolean;
  kind: string;
  pkgPath: string | null;
  func: string | null;
  caller: string | null;
  args: string[] | null;
}
export interface GnoTokenRow {
  token: string;
  realm: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  height: string;
  txHash: string;
}
/** from is "" for a mint, to is "" for a burn. eventIndex is the event's place in the transaction. */
export interface GnoTransferRow { height: string; txHash: string; eventIndex: number; token: string; from: string; to: string; amount: string }
export interface GnoExtracted {
  blocks: GnoBlockRow[];
  txs: GnoTxRow[];
  parties: GnoPartyRow[];
  msgs: GnoMsgRow[];
  tokens: GnoTokenRow[];
  transfers: GnoTransferRow[];
  hollow: number[];
}

/** A gno account address: g1 and 38 bech32 characters (20 bytes). */
const ADDR = /^g1[02-9ac-hj-np-z]{38}$/;

/** The tx-indexer's base64 hash as uppercase hex, the form every other chain's rows use. */
export function hexHash(b64: string | null | undefined): string | null {
  if (!b64) return null;
  const bytes = Buffer.from(b64, "base64");
  return bytes.length === 32 ? bytes.toString("hex").toUpperCase() : null;
}

/** The address that signs a message, by type. */
function signerOf(v: Record<string, unknown> & { __typename: string }): string | null {
  const k = { BankMsgSend: "from_address", MsgCall: "caller", MsgRun: "caller", MsgAddPackage: "creator",
              MsgEnablePackage: "approver", MsgRejectPackage: "sender" }[v.__typename];
  const a = k ? v[k] : null;
  return typeof a === "string" ? a : null;
}

/** Message kinds by type. UnexpectedMessage (create_session, revoke_session) is none of them and has no row. */
const MSG_KIND: Record<string, string> = {
  MsgCall: "call", MsgRun: "run", MsgAddPackage: "addpkg", MsgEnablePackage: "enable", MsgRejectPackage: "reject", BankMsgSend: "send",
};

/** The package a message acts on: the realm called, the package added, approved or rejected. A run's path is
    assigned by the chain, so its transaction usually names none (null). */
function pkgOf(v: Record<string, unknown> & { __typename: string }): string | null {
  const p = v.__typename === "MsgRun" || v.__typename === "MsgAddPackage" ? (v.package as { path?: unknown } | null)?.path : v.pkg_path;
  return typeof p === "string" && p ? clean(p) : null;
}

/** Postgres text cannot hold NUL. */
const clean = (s: string) => s.replace(/\u0000/g, "");

/** A call's arguments, each cut to ARG_MAX characters (marked with an ellipsis). */
export const ARG_MAX = 200;
function argsOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((a) => {
    const cps = Array.from(clean(String(a ?? "")));
    return cps.length > ARG_MAX ? cps.slice(0, ARG_MAX).join("") + "\u2026" : cps.join("");
  });
}

/** Every GRC20 token is built on this package, and it is what emits NewToken and Transfer. */
export const GRC20_PKG = "gno.land/p/nt/grc20/v0";

/** A token key is <realm>.<SYMBOL>.<sequence in hex>: the realm is what is left of it. */
export function realmOf(token: string, symbol: string | null): string | null {
  const m = /^(.*)\.[0-9a-f]+$/.exec(token);
  if (!m) return null;
  const head = m[1];
  if (symbol && head.endsWith("." + symbol)) return head.slice(0, head.length - symbol.length - 1) || null;
  const dot = head.lastIndexOf(".");
  return dot > 0 ? head.slice(0, dot) : null;
}

/**
 * One height range, as the tx-indexer returned it, into rows. Blocks and txs may
 * come in any order; heights with no block are simply absent (the caller only
 * asks for what the tx-indexer holds).
 */
export function extractGno(blocks: GnoBlockIn[], txs: GnoTxIn[]): GnoExtracted {
  const byHeight = new Map<number, GnoTxIn[]>();
  for (const t of txs) {
    const list = byHeight.get(t.block_height) ?? [];
    list.push(t);
    byHeight.set(t.block_height, list);
  }
  const out: GnoExtracted = { blocks: [], txs: [], parties: [], msgs: [], tokens: [], transfers: [], hollow: [] };

  for (const b of [...blocks].sort((x, y) => x.height - y.height)) {
    const list = (byHeight.get(b.height) ?? []).sort((x, y) => x.index - y.index);
    const hollow = list.length !== (b.num_txs ?? 0);
    out.blocks.push({ height: String(b.height), time: b.time, hash: hexHash(b.hash), txCount: b.num_txs ?? 0,
                      version: hollow ? 0 : GNO_EXTRACT_VERSION });
    if (hollow) { out.hollow.push(b.height); continue; }

    for (const t of list) {
      const hash = hexHash(t.hash);
      if (!hash) continue;
      const msgs = t.messages ?? [];
      const roles = new Map<string, number>();
      const add = (a: unknown, role: number) => {
        if (typeof a !== "string" || !ADDR.test(a)) return;
        roles.set(a, (roles.get(a) ?? 0) | role);
      };
      msgs.forEach((m, msgIndex) => {
        const kind = MSG_KIND[m.value?.__typename];
        if (!kind) return;
        const v = m.value;
        out.msgs.push({
          txHash: hash, msgIndex, height: String(t.block_height), success: !!t.success, kind, pkgPath: pkgOf(v),
          func: v.__typename === "MsgCall" && typeof v.func === "string" ? clean(v.func) : null,
          caller: signerOf(v), args: v.__typename === "MsgCall" ? argsOf(v.args) : null,
        });
      });
      for (const m of msgs) {
        const v = m.value;
        const signer = signerOf(v);
        add(signer, GNO_ROLE.signer);
        switch (v.__typename) {
          case "BankMsgSend":
            add(v.from_address, GNO_ROLE.sender);
            add(v.to_address, GNO_ROLE.recipient);
            break;
          case "MsgCall":
          case "MsgRun":
            if (v.send) add(v.caller, GNO_ROLE.sender);
            break;
          case "MsgAddPackage":
            add(v.creator, GNO_ROLE.creator);
            break;
        }
      }
      // What the transaction did, only when it did it: a failed transaction's
      // events describe nothing that happened.
      if (t.success) {
        (t.response?.events ?? []).forEach((e, eventIndex) => {
          if (e.__typename !== "GnoEvent" || e.pkg_path !== GRC20_PKG) return;
          const a = new Map<string, string>();
          for (const x of e.attrs ?? []) if (!a.has(x.key)) a.set(x.key, clean(String(x.value ?? "")));
          const token = a.get("token");
          if (!token) return;
          if (e.type === "NewToken") {
            const symbol = a.get("symbol") ?? null, dec = a.get("decimals") ?? "";
            out.tokens.push({ token, realm: realmOf(token, symbol), name: a.get("name") ?? null, symbol,
                              decimals: /^\d{1,9}$/.test(dec) ? Number(dec) : null, height: String(t.block_height), txHash: hash });
          } else if (e.type === "Transfer") {
            const amount = a.get("value") ?? "";
            if (!/^\d+$/.test(amount)) return;
            out.transfers.push({ height: String(t.block_height), txHash: hash, eventIndex, token,
                                 from: a.get("from") ?? "", to: a.get("to") ?? "", amount });
          }
        });
        for (const e of t.response?.events ?? []) {
          if (e.__typename === "GnoEvent" && e.type === "Transfer") {
            for (const a of e.attrs ?? []) {
              if (a.key === "from") add(a.value, GNO_ROLE.sender);
              else if (a.key === "to") add(a.value, GNO_ROLE.recipient);
            }
          } else if (e.__typename === "TransferEvent") {
            add(e.from, GNO_ROLE.sender);
            add(e.to, GNO_ROLE.recipient);
          }
        }
      }
      const fee = t.gas_fee;
      out.txs.push({
        hash,
        height: String(t.block_height),
        txIndex: t.index,
        time: b.time,
        success: !!t.success,
        gasWanted: t.gas_wanted == null ? null : String(t.gas_wanted),
        gasUsed: t.gas_used == null ? null : String(t.gas_used),
        feeAmount: fee && fee.amount != null && /^\d+$/.test(String(fee.amount)) ? String(fee.amount) : null,
        feeDenom: fee && fee.denom ? fee.denom : null,
        msgTypes: msgs.map((m) => m.value.__typename),
        memo: t.memo ?? "",
        error: t.response?.error ? String(t.response.error).slice(0, 500) : null,
      });
      for (const [address, r] of roles) out.parties.push({ address, height: String(t.block_height), txHash: hash, roles: r });
    }
  }
  return out;
}

/**
 * The GraphQL bounds for heights lo..hi. A negative "gt" returns nothing at all (not even an error), so a window that
 * starts at genesis (height 0) is bounded above only.
 */
export function gnoWindow(lo: number, hi: number): string {
  return lo <= 0 ? `{lt:${hi + 1}}` : `{gt:${lo - 1}, lt:${hi + 1}}`;
}

/** The tx-indexer's GraphQL, by height range. */
export class GnoSource {
  private txFields: string | null = null;
  constructor(private url: string, private timeoutMs = 60_000) {}

  /** Learn which message and event types this tx-indexer knows, and the optional fields; the query follows. */
  async init(): Promise<void> {
    type T = { possibleTypes?: { name: string }[] | null; fields?: { name: string }[] | null } | null;
    const d = await this.q<{ m: T; e: T; call: T; run: T }>(
      '{ m:__type(name:"MessageValue"){ possibleTypes{ name } } e:__type(name:"Event"){ possibleTypes{ name } }' +
      ' call:__type(name:"MsgCall"){ fields{ name } } run:__type(name:"MsgRun"){ fields{ name } } }');
    const names = (t: T, k: "possibleTypes" | "fields") => (t?.[k] ?? []).map((x) => x.name);
    this.txFields = gnoTxFields(names(d.m, "possibleTypes"), names(d.e, "possibleTypes"),
                                { MsgCall: names(d.call, "fields"), MsgRun: names(d.run, "fields") });
  }

  private async q<T>(query: string): Promise<T> {
    const res = await fetch(this.url.replace(/\/$/, "") + "/graphql/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`tx-indexer responded ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`tx-indexer: ${body.errors[0].message}`);
    if (!body.data) throw new Error("tx-indexer: no data");
    return body.data;
  }

  async latest(): Promise<number> {
    return (await this.q<{ latestBlockHeight: number }>("{ latestBlockHeight }")).latestBlockHeight;
  }

  async chainId(): Promise<string | null> {
    const d = await this.q<{ getBlocks: { chain_id: string }[] | null }>("{ getBlocks(where:{height:{eq:1}}){ chain_id } }");
    return d.getBlocks?.[0]?.chain_id ?? null;
  }

  /**
   * The tx-indexer caps a response at 10,000 rows: an older one cuts the list short without saying so, a newer one
   * answers "max elements per query reached" (with the first 10,000). Either way the range is split and asked again,
   * down to a single height.
   */
  private async capped<T>(lo: number, hi: number, read: (lo: number, hi: number) => Promise<T[]>): Promise<T[]> {
    let rows: T[] | null;
    try {
      rows = await read(lo, hi);
    } catch (err) {
      if (!(err instanceof Error && /max elements per query/.test(err.message))) throw err;
      rows = null;
    }
    if ((rows === null || rows.length >= 10_000) && hi > lo) {
      const mid = Math.floor((lo + hi) / 2);
      return [...(await this.capped(lo, mid, read)), ...(await this.capped(mid + 1, hi, read))];
    }
    if (rows === null) throw new Error(`tx-indexer: more than 10,000 rows at height ${lo}`);
    return rows;
  }

  async blocks(lo: number, hi: number): Promise<GnoBlockIn[]> {
    return this.capped(lo, hi, async (a, b) => (await this.q<{ getBlocks: GnoBlockIn[] | null }>(
      `{ getBlocks(where:{height:${gnoWindow(a, b)}}){ ${GNO_BLOCK_FIELDS} } }`)).getBlocks ?? []);
  }

  /** Every transaction in [lo, hi]. */
  async txs(lo: number, hi: number): Promise<GnoTxIn[]> {
    if (!this.txFields) await this.init();
    return this.capped(lo, hi, async (a, b) => (await this.q<{ getTransactions: GnoTxIn[] | null }>(
      `{ getTransactions(where:{block_height:${gnoWindow(a, b)}}){ ${this.txFields} } }`)).getTransactions ?? []);
  }
}
