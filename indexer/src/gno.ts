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
 *   block         the chain's spine, stamped GNO_EXTRACT_VERSION, so coverage
 *                 works exactly as for Cosmos chains
 *
 * The tx-indexer has dropped records before (an amino type it could not decode,
 * fixed 2026-09-26). A block whose transaction count does not match what the
 * tx-indexer returns for it is written hollow (version 0): present, never
 * claimed as covered.
 */

export const GNO_EXTRACT_VERSION = 4;

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
export function gnoTxFields(msgTypes: string[], eventTypes: string[]): string {
  const m = msgTypes.filter((t) => MSG_FRAGS[t]).map((t) => `... on ${t}{ ${MSG_FRAGS[t]} }`).join(" ");
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
export interface GnoExtracted { blocks: GnoBlockRow[]; txs: GnoTxRow[]; parties: GnoPartyRow[]; hollow: number[] }

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
  const out: GnoExtracted = { blocks: [], txs: [], parties: [], hollow: [] };

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

/** The tx-indexer's GraphQL, by height range. */
export class GnoSource {
  private txFields: string | null = null;
  constructor(private url: string, private timeoutMs = 60_000) {}

  /** Learn which message and event types this tx-indexer knows; the query follows. */
  async init(): Promise<void> {
    const d = await this.q<{ m: { possibleTypes: { name: string }[] } | null; e: { possibleTypes: { name: string }[] } | null }>(
      '{ m:__type(name:"MessageValue"){ possibleTypes{ name } } e:__type(name:"Event"){ possibleTypes{ name } } }');
    this.txFields = gnoTxFields((d.m?.possibleTypes ?? []).map((x) => x.name), (d.e?.possibleTypes ?? []).map((x) => x.name));
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

  async blocks(lo: number, hi: number): Promise<GnoBlockIn[]> {
    const d = await this.q<{ getBlocks: GnoBlockIn[] | null }>(
      `{ getBlocks(where:{height:{gt:${lo - 1}, lt:${hi + 1}}}){ ${GNO_BLOCK_FIELDS} } }`);
    return d.getBlocks ?? [];
  }

  /**
   * Every transaction in [lo, hi]. The tx-indexer caps a response at 10,000
   * rows without saying so: a range that comes back at the cap is split and
   * asked again, down to a single height.
   */
  async txs(lo: number, hi: number): Promise<GnoTxIn[]> {
    if (!this.txFields) await this.init();
    const d = await this.q<{ getTransactions: GnoTxIn[] | null }>(
      `{ getTransactions(where:{block_height:{gt:${lo - 1}, lt:${hi + 1}}}){ ${this.txFields} } }`);
    const rows = d.getTransactions ?? [];
    if (rows.length >= 10_000 && hi > lo) {
      const mid = Math.floor((lo + hi) / 2);
      return [...(await this.txs(lo, mid)), ...(await this.txs(mid + 1, hi))];
    }
    return rows;
  }
}
