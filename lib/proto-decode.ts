/**
 * Decodes a message's raw protobuf value (the index's tx_msg.raw) into the
 * JSON the chain's REST API returns for it, so lib/msg-decode reads an old
 * transaction exactly as it reads a recent one.
 *
 * No protobuf library: the decoder below reads the wire format, and SCHEMAS
 * gives the field layout for the messages Scan explains (Cosmos SDK, IBC,
 * authz, AtomOne's gov and PHOTON). A type without a layout decodes to null
 * and the page shows the message by name, as before. Field numbers are from
 * the protos (cosmos-sdk, ibc-go, atomone-hub/atomone); keep them in step.
 */

type Kind =
  | "string"
  | "uint64"
  | "int64"
  | "bool"
  | "bytes"
  /** cosmos.Dec stored as an integer string scaled by 1e18. */
  | "dec"
  | "timestamp"
  | "any"
  | { msg: string }
  | { enum: Record<number, string> };

interface Field {
  name: string;
  kind: Kind;
  repeated?: boolean;
  /** Absent means "unchanged" (MsgEditValidator): no default is filled in. */
  optional?: boolean;
}

type Schema = Record<number, Field>;

const s = (name: string): Field => ({ name, kind: "string" });
const u = (name: string): Field => ({ name, kind: "uint64" });
const m = (name: string, msg: string, repeated = false): Field => ({ name, kind: { msg }, repeated });
const coins = (name: string): Field => m(name, "Coin", true);

const VOTE_OPTION: Record<number, string> = {
  0: "VOTE_OPTION_UNSPECIFIED",
  1: "VOTE_OPTION_YES",
  2: "VOTE_OPTION_ABSTAIN",
  3: "VOTE_OPTION_NO",
  4: "VOTE_OPTION_NO_WITH_VETO",
};

const AUTHORIZATION_TYPE: Record<number, string> = {
  0: "AUTHORIZATION_TYPE_UNSPECIFIED",
  1: "AUTHORIZATION_TYPE_DELEGATE",
  2: "AUTHORIZATION_TYPE_UNDELEGATE",
  3: "AUTHORIZATION_TYPE_REDELEGATE",
  4: "AUTHORIZATION_TYPE_CANCEL_UNBONDING_DELEGATION",
};

/** Building blocks, by short name. */
const PARTS: Record<string, Schema> = {
  Coin: { 1: s("denom"), 2: s("amount") },
  DecCoin: { 1: s("denom"), 2: { name: "amount", kind: "dec" } },
  Input: { 1: s("address"), 2: coins("coins") },
  Output: { 1: s("address"), 2: coins("coins") },
  Description: { 1: s("moniker"), 2: s("identity"), 3: s("website"), 4: s("security_contact"), 5: s("details") },
  CommissionRates: {
    1: { name: "rate", kind: "dec" },
    2: { name: "max_rate", kind: "dec" },
    3: { name: "max_change_rate", kind: "dec" },
  },
  WeightedVoteOption: { 1: { name: "option", kind: { enum: VOTE_OPTION } }, 2: { name: "weight", kind: "dec" } },
  Height: { 1: u("revision_number"), 2: u("revision_height") },
  Packet: {
    1: u("sequence"),
    2: s("source_port"),
    3: s("source_channel"),
    4: s("destination_port"),
    5: s("destination_channel"),
    6: { name: "data", kind: "bytes" },
    7: m("timeout_height", "Height"),
    8: u("timeout_timestamp"),
  },
  Grant: { 1: { name: "authorization", kind: "any" }, 2: { name: "expiration", kind: "timestamp" } },
  Validators: { 1: { name: "address", kind: "string", repeated: true } },
  ParamChange: { 1: s("subspace"), 2: s("key"), 3: s("value") },
  GovernorDescription: { 1: s("moniker"), 2: s("identity"), 3: s("website"), 4: s("security_contact"), 5: s("details") },
};

const vote: Schema = {
  1: u("proposal_id"),
  2: s("voter"),
  3: { name: "option", kind: { enum: VOTE_OPTION } },
  4: s("metadata"),
};
const voteWeighted: Schema = {
  1: u("proposal_id"),
  2: s("voter"),
  3: m("options", "WeightedVoteOption", true),
  4: s("metadata"),
};
const deposit: Schema = { 1: u("proposal_id"), 2: s("depositor"), 3: coins("amount") };
const submitV1: Schema = {
  1: { name: "messages", kind: "any", repeated: true },
  2: coins("initial_deposit"),
  3: s("proposer"),
  4: s("metadata"),
  5: s("title"),
  6: s("summary"),
};

/** Message layouts by type URL. */
const SCHEMAS: Record<string, Schema> = {
  "/cosmos.bank.v1beta1.MsgSend": { 1: s("from_address"), 2: s("to_address"), 3: coins("amount") },
  "/cosmos.bank.v1beta1.MsgMultiSend": { 1: m("inputs", "Input", true), 2: m("outputs", "Output", true) },

  "/cosmos.staking.v1beta1.MsgDelegate": { 1: s("delegator_address"), 2: s("validator_address"), 3: m("amount", "Coin") },
  "/cosmos.staking.v1beta1.MsgUndelegate": { 1: s("delegator_address"), 2: s("validator_address"), 3: m("amount", "Coin") },
  "/cosmos.staking.v1beta1.MsgBeginRedelegate": {
    1: s("delegator_address"),
    2: s("validator_src_address"),
    3: s("validator_dst_address"),
    4: m("amount", "Coin"),
  },
  "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation": {
    1: s("delegator_address"),
    2: s("validator_address"),
    3: m("amount", "Coin"),
    4: { name: "creation_height", kind: "int64" },
  },
  "/cosmos.staking.v1beta1.MsgCreateValidator": {
    1: m("description", "Description"),
    2: m("commission", "CommissionRates"),
    3: s("min_self_delegation"),
    4: s("delegator_address"),
    5: s("validator_address"),
    6: { name: "pubkey", kind: "any" },
    7: m("value", "Coin"),
  },
  "/cosmos.staking.v1beta1.MsgEditValidator": {
    1: m("description", "Description"),
    2: s("validator_address"),
    3: { name: "commission_rate", kind: "dec", optional: true },
    4: { name: "min_self_delegation", kind: "string", optional: true },
  },

  "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": { 1: s("delegator_address"), 2: s("validator_address") },
  "/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission": { 1: s("validator_address") },
  "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress": { 1: s("delegator_address"), 2: s("withdraw_address") },
  "/cosmos.distribution.v1beta1.MsgFundCommunityPool": { 1: coins("amount"), 2: s("depositor") },

  "/cosmos.slashing.v1beta1.MsgUnjail": { 1: s("validator_addr") },

  "/cosmos.gov.v1beta1.MsgVote": vote,
  "/cosmos.gov.v1.MsgVote": vote,
  "/atomone.gov.v1beta1.MsgVote": vote,
  "/atomone.gov.v1.MsgVote": vote,
  "/cosmos.gov.v1beta1.MsgVoteWeighted": voteWeighted,
  "/cosmos.gov.v1.MsgVoteWeighted": voteWeighted,
  "/atomone.gov.v1beta1.MsgVoteWeighted": voteWeighted,
  "/atomone.gov.v1.MsgVoteWeighted": voteWeighted,
  "/cosmos.gov.v1beta1.MsgDeposit": deposit,
  "/cosmos.gov.v1.MsgDeposit": deposit,
  "/atomone.gov.v1beta1.MsgDeposit": deposit,
  "/atomone.gov.v1.MsgDeposit": deposit,
  "/cosmos.gov.v1beta1.MsgSubmitProposal": { 1: { name: "content", kind: "any" }, 2: coins("initial_deposit"), 3: s("proposer") },
  "/atomone.gov.v1beta1.MsgSubmitProposal": { 1: { name: "content", kind: "any" }, 2: coins("initial_deposit"), 3: s("proposer") },
  "/cosmos.gov.v1.MsgSubmitProposal": submitV1,
  "/atomone.gov.v1.MsgSubmitProposal": submitV1,
  "/cosmos.gov.v1beta1.TextProposal": { 1: s("title"), 2: s("description") },
  "/cosmos.params.v1beta1.ParameterChangeProposal": {
    1: s("title"),
    2: s("description"),
    3: m("changes", "ParamChange", true),
  },
  "/atomone.gov.v1beta1.TextProposal": { 1: s("title"), 2: s("description") },
  "/atomone.gov.v1.MsgCreateGovernor": { 1: s("address"), 2: m("description", "GovernorDescription") },
  "/atomone.gov.v1.MsgEditGovernor": { 1: s("address"), 2: m("description", "GovernorDescription") },
  "/atomone.gov.v1.MsgDelegateGovernor": { 1: s("delegator_address"), 2: s("governor_address") },
  "/atomone.gov.v1.MsgUndelegateGovernor": { 1: s("delegator_address") },

  "/atomone.photon.v1.MsgMintPhoton": { 1: s("to_address"), 2: m("amount", "Coin") },

  "/cosmos.authz.v1beta1.MsgExec": { 1: s("grantee"), 2: { name: "msgs", kind: "any", repeated: true } },
  "/cosmos.authz.v1beta1.MsgGrant": { 1: s("granter"), 2: s("grantee"), 3: m("grant", "Grant") },
  "/cosmos.authz.v1beta1.MsgRevoke": { 1: s("granter"), 2: s("grantee"), 3: s("msg_type_url") },
  "/cosmos.authz.v1beta1.GenericAuthorization": { 1: s("msg") },
  "/cosmos.bank.v1beta1.SendAuthorization": { 1: coins("spend_limit"), 2: { name: "allow_list", kind: "string", repeated: true } },
  "/cosmos.staking.v1beta1.StakeAuthorization": {
    1: m("max_tokens", "Coin"),
    2: m("allow_list", "Validators"),
    3: m("deny_list", "Validators"),
    4: { name: "authorization_type", kind: { enum: AUTHORIZATION_TYPE } },
  },
  "/cosmos.feegrant.v1beta1.MsgGrantAllowance": { 1: s("granter"), 2: s("grantee") },
  "/cosmos.feegrant.v1beta1.MsgRevokeAllowance": { 1: s("granter"), 2: s("grantee") },

  "/ibc.applications.transfer.v1.MsgTransfer": {
    1: s("source_port"),
    2: s("source_channel"),
    3: m("token", "Coin"),
    4: s("sender"),
    5: s("receiver"),
    6: m("timeout_height", "Height"),
    7: u("timeout_timestamp"),
    8: s("memo"),
    9: s("encoding"),
  },
  "/ibc.core.client.v1.MsgUpdateClient": { 1: s("client_id"), 3: s("signer") },
  "/ibc.core.channel.v1.MsgRecvPacket": { 1: m("packet", "Packet"), 3: m("proof_height", "Height"), 4: s("signer") },
  "/ibc.core.channel.v1.MsgAcknowledgement": {
    1: m("packet", "Packet"),
    2: { name: "acknowledgement", kind: "bytes" },
    4: m("proof_height", "Height"),
    5: s("signer"),
  },
  "/ibc.core.channel.v1.MsgTimeout": { 1: m("packet", "Packet"), 3: m("proof_height", "Height"), 4: u("next_sequence_recv"), 5: s("signer") },
  "/ibc.core.channel.v1.MsgTimeoutOnClose": {
    1: m("packet", "Packet"),
    4: m("proof_height", "Height"),
    5: u("next_sequence_recv"),
    6: s("signer"),
  },
};

// ── Wire format ─────────────────────────────────────────────────────────────

interface WireField {
  num: number;
  /** 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. */
  wire: number;
  varint?: bigint;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, at: number): [bigint, number] {
  let result = BigInt(0);
  let shift = BigInt(0);
  let i = at;
  for (; i < buf.length; i++) {
    const b = buf[i];
    result |= BigInt(b & 0x7f) << shift;
    shift += BigInt(7);
    if ((b & 0x80) === 0) return [result, i + 1];
    if (shift > BigInt(70)) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

function readFields(buf: Uint8Array): WireField[] {
  const out: WireField[] = [];
  let at = 0;
  while (at < buf.length) {
    const [key, next] = readVarint(buf, at);
    at = next;
    const num = Number(key >> BigInt(3));
    const wire = Number(key & BigInt(7));
    if (wire === 0) {
      const [v, n] = readVarint(buf, at);
      out.push({ num, wire, varint: v });
      at = n;
    } else if (wire === 2) {
      const [len, n] = readVarint(buf, at);
      const end = n + Number(len);
      if (end > buf.length) throw new Error("truncated field");
      out.push({ num, wire, bytes: buf.subarray(n, end) });
      at = end;
    } else if (wire === 1) {
      out.push({ num, wire, bytes: buf.subarray(at, at + 8) });
      at += 8;
    } else if (wire === 5) {
      out.push({ num, wire, bytes: buf.subarray(at, at + 4) });
      at += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

const utf8 = new TextDecoder("utf-8");

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** "100000000000000000" (scaled by 1e18) -> "0.100000000000000000". */
function decString(raw: string): string {
  if (raw.includes(".") || !/^-?\d+$/.test(raw)) return raw;
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).padStart(19, "0");
  return `${neg ? "-" : ""}${digits.slice(0, -18)}.${digits.slice(-18)}`;
}

function timestampOf(bytes: Uint8Array): string | null {
  let seconds = BigInt(0);
  let nanos = 0;
  for (const f of readFields(bytes)) {
    if (f.num === 1 && f.varint !== undefined) seconds = f.varint;
    if (f.num === 2 && f.varint !== undefined) nanos = Number(f.varint);
  }
  const ms = Number(seconds) * 1000 + Math.floor(nanos / 1e6);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function valueOf(f: WireField, kind: Kind, depth: number): unknown {
  if (typeof kind === "object" && "enum" in kind) {
    const n = Number(f.varint ?? 0);
    return kind.enum[n] ?? String(n);
  }
  if (typeof kind === "object" && "msg" in kind) {
    return f.bytes ? decodeWith(PARTS[kind.msg], f.bytes, depth + 1) : null;
  }
  switch (kind) {
    case "string":
      return f.bytes ? utf8.decode(f.bytes) : "";
    case "dec":
      return f.bytes ? decString(utf8.decode(f.bytes)) : "0";
    case "uint64":
    case "int64":
      return (f.varint ?? BigInt(0)).toString();
    case "bool":
      return (f.varint ?? BigInt(0)) !== BigInt(0);
    case "bytes":
      return f.bytes ? toBase64(f.bytes) : "";
    case "timestamp":
      return f.bytes ? timestampOf(f.bytes) : null;
    case "any":
      return f.bytes ? decodeAnyBytes(f.bytes, depth + 1) : null;
  }
  return null;
}

function decodeWith(schema: Schema | undefined, bytes: Uint8Array, depth: number): Record<string, unknown> | null {
  if (!schema || depth > 8) return null;
  const out: Record<string, unknown> = {};
  for (const f of readFields(bytes)) {
    const field = schema[f.num];
    if (!field) continue;
    const v = valueOf(f, field.kind, depth);
    if (field.repeated) ((out[field.name] as unknown[] | undefined) ??= []).push(v);
    else out[field.name] = v;
  }
  // proto3 leaves zero values off the wire; the REST API prints them.
  for (const field of Object.values(schema)) {
    if (out[field.name] !== undefined) continue;
    if (field.optional) out[field.name] = null;
    else if (field.repeated) out[field.name] = [];
    else if (typeof field.kind === "object" && "enum" in field.kind) out[field.name] = field.kind.enum[0] ?? "0";
    else if (field.kind === "string" || field.kind === "bytes") out[field.name] = "";
    else if (field.kind === "uint64" || field.kind === "int64") out[field.name] = "0";
    else if (field.kind === "bool") out[field.name] = false;
    else if (field.kind === "dec") out[field.name] = "0.000000000000000000";
    else if (field.kind === "timestamp" || field.kind === "any") out[field.name] = null;
  }
  return out;
}

/** A google.protobuf.Any: its type URL and, where Scan knows the type, its fields. */
function decodeAnyBytes(bytes: Uint8Array, depth: number): Record<string, unknown> {
  let typeUrl = "";
  let value: Uint8Array | undefined;
  for (const f of readFields(bytes)) {
    if (f.num === 1 && f.bytes) typeUrl = utf8.decode(f.bytes);
    if (f.num === 2 && f.bytes) value = f.bytes;
  }
  const inner = value ? decodeWith(SCHEMAS[typeUrl], value, depth) : null;
  return inner ? { "@type": typeUrl, ...inner } : { "@type": typeUrl, value: value ? toBase64(value) : "" };
}

/**
 * The message as the REST API would show it, or null when Scan has no layout
 * for its type (or the bytes do not parse).
 */
export function decodeRawMessage(typeUrl: string, raw: Uint8Array | null | undefined): Record<string, unknown> | null {
  if (!raw || !SCHEMAS[typeUrl]) return null;
  try {
    const out = decodeWith(SCHEMAS[typeUrl], raw, 0);
    return out ? { "@type": typeUrl, ...out } : null;
  } catch {
    return null;
  }
}

/** Test seam: whether a type has a layout. */
export function hasLayout(typeUrl: string): boolean {
  return typeUrl in SCHEMAS;
}
