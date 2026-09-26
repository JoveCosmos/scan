/**
 * Just enough protobuf to read a transaction's own bytes.
 *
 * ABCI events carry the value that moved, but not everything a transaction is:
 * a failed transaction emits no message events at all, the memo and the fee
 * granter never appear in an event, and an authz MsgExec only names its inner
 * messages through the events those messages happen to emit. The raw bytes in
 * every block answer all of that, and the wire format needed to read them is
 * four field types and one varint - no generated code, no dependency.
 *
 *   TxRaw     { body_bytes = 1; auth_info_bytes = 2; signatures = 3 }
 *   TxBody    { messages = 1 (Any, repeated); memo = 2; timeout_height = 3 }
 *   AuthInfo  { signer_infos = 1; fee = 2 }
 *   Fee       { amount = 1 (Coin, repeated); gas_limit = 2; payer = 3; granter = 4 }
 *   Any       { type_url = 1; value = 2 }
 *   Coin      { denom = 1; amount = 2 }
 *   MsgExec   { grantee = 1; msgs = 2 (Any, repeated) }
 *
 * Everything here is defensive: a field it does not understand is skipped, and a
 * malformed buffer yields what could be read before the damage rather than a throw.
 */

export interface Field {
  no: number;
  wire: number;
  /** Varint value (wire 0), as a bigint so a uint64 survives. */
  varint?: bigint;
  /** Length-delimited payload (wire 2). */
  bytes?: Uint8Array;
}

/** One protobuf message's fields, in wire order. Stops at the first malformed byte. */
const B0 = BigInt(0);
const B3 = BigInt(3);
const B7 = BigInt(7);
const B70 = BigInt(70);
const MASK = BigInt(0x7f);

export function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const n = buf.length;

  const varint = (): bigint | null => {
    let shift = B0;
    let v = B0;
    while (i < n) {
      const b = buf[i++];
      v |= (BigInt(b) & MASK) << shift;
      if ((b & 0x80) === 0) return v;
      shift += B7;
      if (shift > B70) return null;
    }
    return null;
  };

  while (i < n) {
    const key = varint();
    if (key === null) break;
    const no = Number(key >> B3);
    const wire = Number(key & B7);
    if (no === 0) break;
    if (wire === 0) {
      const v = varint();
      if (v === null) break;
      out.push({ no, wire, varint: v });
    } else if (wire === 2) {
      const len = varint();
      if (len === null || i + Number(len) > n) break;
      out.push({ no, wire, bytes: buf.subarray(i, i + Number(len)) });
      i += Number(len);
    } else if (wire === 1) {
      if (i + 8 > n) break;
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > n) break;
      i += 4;
    } else {
      // Groups (3, 4) are long dead in Cosmos messages; anything else is corruption.
      break;
    }
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A length-delimited field as UTF-8, or null when it is not valid text. */
export function text(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export interface AnyMsg {
  typeUrl: string;
  value: Uint8Array;
}

export interface Coin {
  denom: string;
  amount: string;
}

export interface DecodedTx {
  messages: AnyMsg[];
  memo: string;
  feeCoins: Coin[];
  gasLimit: string | null;
  feePayer: string | null;
  feeGranter: string | null;
}

function decodeAny(bytes: Uint8Array): AnyMsg | null {
  let typeUrl: string | null = null;
  let value: Uint8Array = new Uint8Array(0);
  for (const f of fields(bytes)) {
    if (f.no === 1 && f.wire === 2) typeUrl = text(f.bytes);
    else if (f.no === 2 && f.wire === 2 && f.bytes) value = f.bytes;
  }
  return typeUrl ? { typeUrl, value } : null;
}

function decodeCoin(bytes: Uint8Array): Coin | null {
  let denom: string | null = null;
  let amount: string | null = null;
  for (const f of fields(bytes)) {
    if (f.no === 1 && f.wire === 2) denom = text(f.bytes);
    else if (f.no === 2 && f.wire === 2) amount = text(f.bytes);
  }
  return denom && amount && /^\d+$/.test(amount) ? { denom, amount } : null;
}

/** The parts of a transaction the events do not carry. Null when the bytes are not a TxRaw. */
export function decodeTx(rawBase64: string): DecodedTx | null {
  const raw = Buffer.from(rawBase64, "base64");
  let body: Uint8Array | undefined;
  let authInfo: Uint8Array | undefined;
  for (const f of fields(raw)) {
    if (f.no === 1 && f.wire === 2) body = f.bytes;
    else if (f.no === 2 && f.wire === 2) authInfo = f.bytes;
  }
  if (!body) return null;

  const out: DecodedTx = {
    messages: [],
    memo: "",
    feeCoins: [],
    gasLimit: null,
    feePayer: null,
    feeGranter: null,
  };

  for (const f of fields(body)) {
    if (f.no === 1 && f.wire === 2 && f.bytes) {
      const any = decodeAny(f.bytes);
      if (any) out.messages.push(any);
    } else if (f.no === 2 && f.wire === 2) {
      out.memo = text(f.bytes) ?? "";
    }
  }

  if (authInfo) {
    for (const f of fields(authInfo)) {
      if (f.no !== 2 || f.wire !== 2 || !f.bytes) continue;
      for (const g of fields(f.bytes)) {
        if (g.no === 1 && g.wire === 2 && g.bytes) {
          const c = decodeCoin(g.bytes);
          if (c) out.feeCoins.push(c);
        } else if (g.no === 2 && g.wire === 0 && g.varint !== undefined) {
          out.gasLimit = g.varint.toString();
        } else if (g.no === 3 && g.wire === 2) {
          out.feePayer = text(g.bytes) || null;
        } else if (g.no === 4 && g.wire === 2) {
          out.feeGranter = text(g.bytes) || null;
        }
      }
    }
  }
  return out;
}

export const MSG_EXEC = "/cosmos.authz.v1beta1.MsgExec";

/** An authz MsgExec's inner messages, in order. */
export function execInner(value: Uint8Array): AnyMsg[] {
  const out: AnyMsg[] = [];
  for (const f of fields(value)) {
    if (f.no === 2 && f.wire === 2 && f.bytes) {
      const any = decodeAny(f.bytes);
      if (any) out.push(any);
    }
  }
  return out;
}

/** bech32 shape: a lowercase human part, the "1" separator, 38+ data characters. */
const BECH32ISH = /^[a-z][a-z0-9]{1,82}1[02-9ac-hj-np-z]{38,}$/;

/**
 * The address that sent a message, read positionally.
 *
 * Every Cosmos SDK message names its signer in a top-level string field, and in
 * every message this indexer has met that field is the first top-level string
 * shaped like an address: MsgSend.from_address, MsgDelegate.delegator_address,
 * MsgVote.voter (after the numeric proposal id), MsgExec.grantee,
 * MsgTransfer.sender (after port and channel), MsgRecvPacket.signer (after the
 * packet, which is a nested message, not a string). MsgMultiSend has no
 * top-level string at all - its sender is inputs[0].address - so one level of
 * nesting is searched when the top level has none.
 */
export function messageSender(value: Uint8Array): string | null {
  const top = fields(value);
  for (const f of top) {
    if (f.wire !== 2) continue;
    const s = text(f.bytes);
    if (s && BECH32ISH.test(s)) return s;
  }
  for (const f of top) {
    if (f.wire !== 2 || !f.bytes || f.bytes.length < 40) continue;
    for (const g of fields(f.bytes)) {
      if (g.wire !== 2) continue;
      const s = text(g.bytes);
      if (s && BECH32ISH.test(s)) return s;
    }
  }
  return null;
}

/**
 * A MsgCreateValidator's validator operator and consensus public key.
 *
 *   description = 1; commission = 2; min_self_delegation = 3;
 *   delegator_address = 4 (deprecated); validator_address = 5; pubkey = 6 (Any); value = 7
 *
 * The pubkey Any wraps { key = 1 } for ed25519. Null for anything else.
 */
export function createValidatorKey(
  value: Uint8Array
): { operator: string; pubkey: Uint8Array; keyType: string } | null {
  let operator: string | null = null;
  let pk: AnyMsg | null = null;
  for (const f of fields(value)) {
    if (f.no === 5 && f.wire === 2) operator = text(f.bytes);
    else if (f.no === 6 && f.wire === 2 && f.bytes) pk = decodeAny(f.bytes);
  }
  if (!operator || !pk) return null;
  let key: Uint8Array | undefined;
  for (const f of fields(pk.value)) {
    if (f.no === 1 && f.wire === 2) key = f.bytes;
  }
  return key ? { operator, pubkey: key, keyType: pk.typeUrl } : null;
}
