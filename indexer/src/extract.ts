import { createHash } from "node:crypto";
import { bech32 } from "bech32";
import { placeEvents, type Placed } from "./events";
import {
  decodeTx,
  execInner,
  messageSender,
  createValidatorKey,
  MSG_EXEC,
  type Coin,
} from "./proto";

/**
 * Turn one block's RPC responses into rows.
 *
 * Pure functions over the JSON the node returns — no network, no database — so
 * the whole extraction is testable against captured fixtures.
 *
 * Everything comes from `/block` and `/block_results`. Notably we never call
 * tx-search, so this works against a node with `tx_index: off`. Value movements
 * come from ABCI events (a reward withdrawal's *amount* exists only in the
 * event); what the events never carry — a failed transaction's messages, the
 * memo, the fee granter, an authz MsgExec's inner message types — is read from
 * the transaction's own bytes (proto.ts, a few dozen lines of wire format).
 */

/**
 * Which facts this extractor pulls out of a block.
 *
 * Stored on every block row so a reader can tell "we have this block" apart
 * from "we have everything this block contained". Those diverged once already:
 * blocks written before votes were extracted looked complete, so a proposal
 * spanning them reported a fraction of its votes as though that were the total.
 *
 * Bump this whenever a new kind of row starts being extracted, and refill. A
 * reader never compares against this number directly: it asks for a capability
 * (CAPABILITIES below, and the `extract_capability` table), so raising the
 * version cannot make an existing feature go dark while a refill runs.
 *
 *   1  fees and transfers
 *   2  + governance votes and slashing events
 *   3  + missed commit signatures
 *   4  transfers keyed by event (no collisions; pre-upgrade grouping recovered
 *      from the log; MultiSend senders), tx memo/signers/fee granter/codespace/
 *      all fee coins, tx_party, tx_msg (from the bytes, authz inner messages and
 *      failed txs included), ibc_packet, staking_event, validator_power,
 *      gov_deposit, gov_proposal, vote_event, double-sign tombstones, unjails
 *   0  a block whose node returned no ABCI results although it has
 *      transactions: present, but nothing derived from events can be trusted
 */
export const EXTRACT_VERSION = 4;

/**
 * Capability -> the lowest extract_version that carries it.
 *
 * The contract with every reader (Scan, the GATA reconcile). A reader checks
 * coverage for the capability it actually uses — `indexer_coverage(chain,
 * capability)` in SQL — never for EXTRACT_VERSION, so a new version only widens
 * what is covered. Mirrored in sql/008 as the `extract_capability` table.
 */
export const CAPABILITIES = {
  blocks: 0,
  fees: 1,
  votes: 2,
  slashing: 2,
  missed_signatures: 3,
  transfers: 4,
  tx_meta: 4,
  tx_party: 4,
  tx_msg: 4,
  ibc_packet: 4,
  staking_event: 4,
  validator_power: 4,
  gov_deposit: 4,
  gov_proposal: 4,
  vote_event: 4,
  tombstones_unjails: 4,
} as const;
export type Capability = keyof typeof CAPABILITIES;

export interface Attr {
  key: string;
  value?: string;
}

export interface Event {
  type: string;
  attributes?: Attr[];
}

export interface TxResult {
  code?: number;
  codespace?: string;
  /** Pre-upgrade: JSON listing each message's events. Post-upgrade: empty. */
  log?: string;
  gas_used?: string;
  gas_wanted?: string;
  events?: Event[];
}

/**
 * One slot in a commit.
 *
 * `block_id_flag`: 1 absent, 2 commit, 3 nil. An ABSENT slot carries an EMPTY
 * validator_address - the node does not say who failed to show up. The array is
 * positional against the validator set at that height, so attribution needs that
 * set, which is why resolveMissed() refuses to guess without it.
 */
export interface CommitSig {
  block_id_flag?: number | string;
  validator_address?: string;
  timestamp?: string;
  signature?: string | null;
}

export interface MissedSignatureRow {
  /** The height that went unsigned - one below the block this came from. */
  height: string;
  consAddr: string;
  /** absent | nil */
  flag: string;
}

export interface BlockResponse {
  result?: {
    block_id?: { hash?: string };
    block?: {
      header?: { height?: string; time?: string; proposer_address?: string };
      data?: { txs?: string[] | null };
      /**
       * The commit for the PREVIOUS height, signed by the validator set as it
       * stood there. Already on the wire for every block we fetch.
       */
      last_commit?: { height?: string; signatures?: CommitSig[] | null };
    };
  };
}

export interface ValidatorUpdate {
  pub_key?: {
    /** CometBFT 0.38 JSON: { Sum: { type, value: { ed25519 } } } */
    Sum?: { type?: string; value?: { ed25519?: string; secp256k1?: string } };
    /** Older amino JSON: { type: "tendermint/PubKeyEd25519", value: base64 } */
    type?: string;
    value?: string;
  };
  /** Absent means zero: the validator left the set. */
  power?: string;
}

export interface BlockResultsResponse {
  result?: {
    height?: string;
    txs_results?: TxResult[] | null;
    /** CometBFT 0.38+. Older nodes split this into begin/end_block_events. */
    finalize_block_events?: Event[] | null;
    begin_block_events?: Event[] | null;
    end_block_events?: Event[] | null;
    validator_updates?: ValidatorUpdate[] | null;
  };
}

const FLAG_ABSENT = 1;
const FLAG_COMMIT = 2;
const FLAG_NIL = 3;

function flagOf(sig: CommitSig): number {
  const f = sig.block_id_flag;
  if (typeof f === "number") return f;
  if (f === "BLOCK_ID_FLAG_ABSENT") return FLAG_ABSENT;
  if (f === "BLOCK_ID_FLAG_NIL") return FLAG_NIL;
  return FLAG_COMMIT;
}

/** The height a block's commit covers, or null when it carries none (genesis). */
export function commitHeight(block: BlockResponse): string | null {
  return block.result?.block?.last_commit?.height ?? null;
}

export function commitSignatures(block: BlockResponse): CommitSig[] {
  return block.result?.block?.last_commit?.signatures ?? [];
}

/**
 * Resolve which validators missed a commit, positionally against a known set.
 *
 * Reports `mismatch` instead of rows whenever the set cannot be trusted to line
 * up - a different length, or any PRESENT slot whose address is not the one the
 * set holds at that index. Present slots carry their address and are ~99.9% of
 * every commit, so this is a strong check: bonding, unbonding or a power
 * reordering all surface immediately as a misaligned address.
 *
 * It must never guess. These rows say a named operator was offline, and pinning
 * that on the wrong validator because the set was stale would be a lie about
 * somebody's service.
 */
export function resolveMissed(
  sigs: CommitSig[],
  set: string[],
  height: string
): { missed: MissedSignatureRow[]; mismatch: boolean } {
  if (sigs.length === 0) return { missed: [], mismatch: false };
  if (set.length !== sigs.length) return { missed: [], mismatch: true };

  const missed: MissedSignatureRow[] = [];
  for (let i = 0; i < sigs.length; i++) {
    const flag = flagOf(sigs[i]);
    const addr = sigs[i].validator_address ?? "";
    if (flag === FLAG_COMMIT) {
      if (addr && addr !== set[i]) return { missed: [], mismatch: true };
      continue;
    }
    missed.push({
      height,
      consAddr: set[i],
      flag: flag === FLAG_NIL ? "nil" : "absent",
    });
  }
  return { missed, mismatch: false };
}

export interface BlockRow {
  height: string;
  time: string;
  proposerCons: string | null;
  hash: string | null;
  txCount: number;
}

export interface TxRow {
  hash: string;
  height: string;
  txIndex: number;
  time: string;
  code: number;
  codespace: string | null;
  /** The first fee coin, kept for the readers that already use these two. */
  feeDenom: string | null;
  feeAmount: string | null;
  /** Every fee coin. */
  feeCoins: Coin[];
  gasUsed: string | null;
  gasWanted: string | null;
  /** Fee payer, else the first signer, else the first message's sender. */
  signer: string | null;
  /** Every signer, in signing order, from the ante handler's acc_seq attributes. */
  signers: string[];
  feeGranter: string | null;
  memo: string | null;
  /**
   * Message type URLs in order, for the type pills. From the message events'
   * `action`, as before; a failed transaction emits none, so its top-level
   * types are read from the bytes instead.
   */
  msgTypes: string[];
}

export type TransferKind = "transfer" | "reward" | "commission" | "fee";

export interface TransferRow {
  txHash: string;
  /** The event's ordinal within the transaction — with coinIndex, the key. */
  eventSeq: number;
  /** -1 for the ante handler's fee deduction. */
  msgIndex: number;
  /** The inner message of an authz MsgExec that moved it, when one did. */
  authzMsgIndex: number | null;
  coinIndex: number;
  height: string;
  time: string;
  kind: TransferKind;
  fromAddr: string | null;
  toAddr: string | null;
  denom: string;
  amount: string;
}

export interface VoteOption {
  option: string;
  weight: string;
}

export interface VoteRow {
  proposalId: string;
  /** The granter on an authz vote — the account whose stake the vote carries. */
  voter: string;
  /** Heaviest option; the whole vote for anyone but a split voter. */
  option: string;
  weighted: boolean;
  options: VoteOption[] | null;
  height: string;
  time: string;
  txHash: string;
  /** The proposal_vote event's ordinal in the tx; the vote_event key. */
  eventSeq: number;
}

export type SlashKind = "slashed" | "jailed" | "unjailed" | "tombstoned";

export interface SlashRow {
  height: string;
  time: string;
  /**
   * Consensus address, bech32 valcons — the only identity the events carry.
   * An unjail names only its operator, so its row carries the operator here
   * until the database resolves it through validator_key (see db.ts).
   */
  consAddr: string;
  /** Validator operator, when the source names one (unjails). */
  operator: string | null;
  kind: SlashKind;
  /** downtime | double_sign, when the chain says. */
  reason: string | null;
  burned: string | null;
}

/** Role bits on a tx_party row: why an address is a party to a transaction. */
export const ROLE = {
  signer: 1,
  fee_payer: 2,
  fee_granter: 4,
  sender: 8,
  recipient: 16,
  delegator: 32,
  validator: 64,
  voter: 128,
  depositor: 256,
  proposer: 512,
  granter: 1024,
  grantee: 2048,
  relayer: 4096,
  other: 8192,
} as const;

export interface TxPartyRow {
  address: string;
  height: string;
  txHash: string;
  roles: number;
}

export interface TxMsgRow {
  txHash: string;
  height: string;
  msgIndex: number;
  /** -1 for a top-level message; the position inside a MsgExec otherwise. */
  innerIndex: number;
  typeUrl: string;
  sender: string | null;
}

/**
 * One IBC packet as seen from this chain, merged column-wise: each event fills
 * only its own columns, so a send and its acknowledgement written blocks apart —
 * or in either order, as a descending refill meets them — compose into one row.
 */
export interface IbcPacketRow {
  /** out: this chain sent it; in: this chain received it. */
  direction: "out" | "in";
  srcPort: string;
  srcChannel: string;
  sequence: string;
  dstPort?: string | null;
  dstChannel?: string | null;
  connection?: string | null;
  sender?: string | null;
  receiver?: string | null;
  denom?: string | null;
  amount?: string | null;
  memo?: string | null;
  timeoutHeight?: string | null;
  timeoutTimestamp?: string | null;
  sendHeight?: string | null;
  sendTx?: string | null;
  sendTime?: string | null;
  recvHeight?: string | null;
  recvTx?: string | null;
  recvTime?: string | null;
  recvRelayer?: string | null;
  ackHeight?: string | null;
  ackTx?: string | null;
  ackTime?: string | null;
  ackRelayer?: string | null;
  ackOk?: boolean | null;
  ackError?: string | null;
  timeoutAtHeight?: string | null;
  timeoutTx?: string | null;
}

export type StakingKind =
  | "delegate"
  | "undelegate"
  | "redelegate"
  | "cancel_unbonding"
  | "create_validator"
  | "edit_validator"
  | "complete_unbonding"
  | "complete_redelegation";

export interface StakingEventRow {
  height: string;
  time: string;
  /** "" for an end-block event (unbonding and redelegation completions). */
  txHash: string;
  eventSeq: number;
  kind: StakingKind;
  validator: string | null;
  validatorDst: string | null;
  delegator: string | null;
  amount: string | null;
  denom: string | null;
  completionTime: string | null;
  creationHeight: string | null;
  msgIndex: number | null;
  authzMsgIndex: number | null;
}

export interface ValidatorPowerRow {
  height: string;
  /** Uppercase hex, the form block.proposer_cons and missed_signature use. */
  consAddr: string;
  power: string;
}

export interface GovDepositRow {
  txHash: string;
  eventSeq: number;
  proposalId: string;
  depositor: string | null;
  coins: Coin[];
  height: string;
  time: string;
}

export interface GovProposalRow {
  proposalId: string;
  submitHeight?: string | null;
  submitTx?: string | null;
  submitTime?: string | null;
  proposer?: string | null;
  messages?: string[] | null;
  /** passed | rejected | failed | dropped, or the chain's own word. */
  outcome?: string | null;
  outcomeHeight?: string | null;
  outcomeTime?: string | null;
}

export interface ValidatorKeyRow {
  operator: string;
  /** Uppercase hex, as block.proposer_cons and missed_signature write it. */
  consHex: string;
  /** bech32 valcons, as slash_event writes it. */
  consValcons: string;
  height: string;
}

export interface ExtractedBlock {
  block: BlockRow;
  txs: TxRow[];
  transfers: TransferRow[];
  votes: VoteRow[];
  slashes: SlashRow[];
  /** Validators that missed the commit this block carries, for height-1. */
  missed: MissedSignatureRow[];
  txParties: TxPartyRow[];
  txMsgs: TxMsgRow[];
  ibcPackets: IbcPacketRow[];
  stakingEvents: StakingEventRow[];
  validatorPower: ValidatorPowerRow[];
  govDeposits: GovDepositRow[];
  govProposals: GovProposalRow[];
  validatorKeys: ValidatorKeyRow[];
  /**
   * The block has transactions but the node returned no ABCI results for them.
   *
   * Symptom of `discard_abci_responses = true`, or of an archive that pruned
   * responses beyond a window. The rows are then hollow — no fee, no signer, no
   * transfers — which looks like a quiet success rather than missing data, so
   * the block is stamped extract_version 0 and nothing derived from events is
   * written for it (db.ts), rather than overwriting good rows with hollow ones.
   */
  abciResultsMissing: boolean;
  /** EXTRACT_VERSION, or 0 when abciResultsMissing. */
  extractVersion: number;
}

/** Attributes as a plain object; later keys of the same name win. */
function attrs(event: Event): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of event.attributes ?? []) {
    if (a.key) out[a.key] = a.value ?? "";
  }
  return out;
}

/**
 * A transaction hash is the sha256 of its raw bytes, uppercase hex.
 *
 * Verified against the chain: a hash derived this way from a block's base64 tx
 * resolves to the same transaction at the same height. This is what lets the
 * indexer work without the node's transaction index.
 */
export function txHash(rawBase64: string): string {
  return createHash("sha256")
    .update(Buffer.from(rawBase64, "base64"))
    .digest("hex")
    .toUpperCase();
}

/**
 * Parse a Cosmos coin list: "1461883uatone,2247uphoton".
 *
 * Denoms are not always simple — `ibc/ABC…` and `factory/…` contain digits and
 * slashes — so the split is on the first run of digits rather than a character
 * class over the denom.
 */
export function parseCoins(value: string): { denom: string; amount: string }[] {
  const out: { denom: string; amount: string }[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = /^(\d+)(.+)$/.exec(trimmed);
    if (!m) continue;
    out.push({ amount: m[1], denom: m[2] });
  }
  return out;
}

/** One coin, or a bare integer amount (older staking events carry no denom). */
function coinOrAmount(value: string | undefined): { amount: string | null; denom: string | null } {
  if (!value) return { amount: null, denom: null };
  const c = parseCoins(value);
  if (c.length > 0) return { amount: c[0].amount, denom: c[0].denom };
  return /^\d+$/.test(value.trim())
    ? { amount: value.trim(), denom: null }
    : { amount: null, denom: null };
}

/**
 * Parse the gov module's stringified WeightedVoteOption list.
 *
 * The event carries the protobuf's text form rather than JSON:
 *
 *   option:VOTE_OPTION_YES weight:"1.000000000000000000"
 *
 * and repeats that pair for a split vote. Parsed rather than pattern-matched on
 * the whole string so a weighted vote keeps every option and weight.
 */
export function parseVoteOptions(raw: string): VoteOption[] {
  const out: VoteOption[] = [];

  // Since the chains' cosmos-sdk v0.50 line (AtomOne v4), the event carries the
  // options as JSON instead: [{"option":3,"weight":"1.000000000000000000"}],
  // with the option as the enum's NUMBER (1 yes, 2 abstain, 3 no, 4 veto) or,
  // on some chains, its name. Missing this form dropped every post-upgrade vote
  // (audit 2026-10-13: the testnet vote table was empty).
  const NUM: Record<string, string> = {
    "1": "VOTE_OPTION_YES", "2": "VOTE_OPTION_ABSTAIN",
    "3": "VOTE_OPTION_NO", "4": "VOTE_OPTION_NO_WITH_VETO",
  };
  const t = raw.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t);
      for (const o of Array.isArray(parsed) ? parsed : [parsed]) {
        if (o == null || o.option == null) continue;
        const name = NUM[String(o.option)] ?? String(o.option);
        out.push({ option: name, weight: String(o.weight ?? "1") });
      }
    } catch {
      /* not JSON after all: fall through to the text forms */
    }
    if (out.length > 0) return out;
  }

  const re = /option:(\S+)\s+weight:"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push({ option: m[1], weight: m[2] });
  }

  // Older chains emit the bare enum with no weight at all.
  if (out.length === 0) {
    const bare = raw.trim();
    if (/^VOTE_OPTION_/.test(bare)) out.push({ option: bare, weight: "1" });
  }
  return out;
}

/**
 * Votes cast in this transaction.
 *
 * Read from the `proposal_vote` event, not the message body, which matters for
 * two reasons: no protobuf decoding is needed, and the event names the *voter*
 * — the granter — so a vote cast through an authz grant is attributed correctly
 * without unwrapping anything. Reading the signer instead would credit the
 * grantee, the exact bug that made Scan under-count AtomOne proposals.
 */
export function extractVotes(
  events: Event[],
  txHashValue: string,
  height: string,
  time: string
): VoteRow[] {
  const out: VoteRow[] = [];

  events.forEach((event, seq) => {
    if (event.type !== "proposal_vote") return;
    const a = attrs(event);
    const proposalId = a.proposal_id;
    const voter = a.voter;
    if (!proposalId || !voter) return;

    const options = parseVoteOptions(a.option ?? "");
    if (options.length === 0) return;

    // Heaviest option represents the vote; ties keep the first, which matches
    // how Scan already summarises weighted votes.
    const primary = [...options].sort(
      (x, y) => Number(y.weight) - Number(x.weight)
    )[0];

    out.push({
      proposalId,
      voter,
      option: primary.option,
      weighted: options.length > 1,
      options: options.length > 1 ? options : null,
      height,
      time,
      txHash: txHashValue,
      eventSeq: seq,
    });
  });

  return out;
}

/**
 * Jailing, slashing and tombstoning, from a block's own events.
 *
 * This is the data no node can serve after the fact: slashing happens in
 * BeginBlock rather than a transaction, so it is absent from tx search, and the
 * module keeps only a current `jailed_until` with no history.
 *
 * Downtime arrives as ONE `slash` event carrying the address, the reason and,
 * when it jails, a `jailed` attribute. A double sign (x/evidence) arrives as
 * TWO: the slash with address and reason, then a second `slash` event carrying
 * only `jailed`. That second one has no `address`, and skipping it for that is
 * how AtomOne's one double sign (height 1,663,342) came to have a slash row and
 * no tombstone. A `jailed` without an address inherits the reason of the slash
 * against the same validator earlier in the block; a double sign tombstones.
 *
 * Deliberately ignores `liveness`, which fires only for a validator that missed
 * the block, with a running counter — not an event worth a row. Who missed each
 * block is recorded exactly in missed_signature instead.
 */
export function extractSlashes(
  events: Event[],
  height: string,
  time: string
): SlashRow[] {
  const out: SlashRow[] = [];
  const reasonOf = new Map<string, string | null>();

  for (const event of events) {
    if (event.type !== "slash") continue;
    const a = attrs(event);
    const consAddr = a.address;

    if (consAddr) {
      // "missing_signature" is the chain's wording; "downtime" is the reader's.
      const reason =
        a.reason === "missing_signature"
          ? "downtime"
          : a.reason === "double_sign"
            ? "double_sign"
            : (a.reason ?? null);
      reasonOf.set(consAddr, reason);

      out.push({
        height,
        time,
        consAddr,
        operator: null,
        kind: "slashed",
        reason,
        burned: a.burned_coins || null,
      });

      // A `jailed` attribute means the same event also jailed the validator. It
      // is recorded separately so "how many times jailed" is a count of rows
      // rather than a filter on a nullable column.
      if (a.jailed) {
        out.push({
          height,
          time,
          consAddr: a.jailed,
          operator: null,
          // Double-signing tombstones permanently; downtime only jails.
          kind: reason === "double_sign" ? "tombstoned" : "jailed",
          reason,
          burned: null,
        });
      }
      continue;
    }

    // The evidence module's second event: `jailed` alone.
    if (a.jailed) {
      const reason = reasonOf.get(a.jailed) ?? null;
      const kind: SlashKind = reason === "double_sign" ? "tombstoned" : "jailed";
      if (!out.some((r) => r.consAddr === a.jailed && r.kind === kind)) {
        out.push({ height, time, consAddr: a.jailed, operator: null, kind, reason, burned: null });
      }
    }
  }

  return out;
}

/** Events emitted outside any transaction, across CometBFT versions. */
export function blockEvents(results: BlockResultsResponse): Event[] {
  const r = results.result ?? {};
  return [
    ...(r.finalize_block_events ?? []),
    ...(r.begin_block_events ?? []),
    ...(r.end_block_events ?? []),
  ];
}

// ── addresses ────────────────────────────────────────────────────────────────

const BECH32 = /^[a-z][a-z0-9]{1,82}1[02-9ac-hj-np-z]{38,}$/;

/** A bech32 account or operator address's 20/32 raw bytes, hex; null otherwise. */
function addressBytes(value: string): string | null {
  if (!BECH32.test(value)) return null;
  try {
    const d = bech32.decode(value, 256);
    // Consensus addresses and public keys are identities, not parties.
    if (/valcons$|pub$/.test(d.prefix)) return null;
    const bytes = Buffer.from(bech32.fromWords(d.words));
    return bytes.length === 20 || bytes.length === 32 ? bytes.toString("hex") : null;
  } catch {
    return null;
  }
}

const sha20 = (s: string | Buffer) =>
  createHash("sha256").update(s).digest().subarray(0, 20).toString("hex");

/**
 * Module accounts, by their raw bytes (the same on every chain: sha256 of the
 * module name). They are a party to nearly everything — the fee collector to
 * every signed transaction — so as tx_party rows they would be millions of rows
 * answering no one's question. Their movements stay in `transfer`. IBC escrow
 * accounts are derived the ICS-20 way, for the first 500 channels.
 */
const MODULE_BYTES = new Set<string>([
  ...[
    "fee_collector",
    "distribution",
    "bonded_tokens_pool",
    "not_bonded_tokens_pool",
    "gov",
    "mint",
    "transfer",
    "photon",
    "feemarket",
    "dynamicfee",
    "interchainaccounts",
    "icahost",
    "icacontroller",
    "feeibc",
    "nft",
    "crisis",
    "upgrade",
    "provider",
    "consumer",
    "wasm",
    "globalfee",
    "tokenfactory",
  ].map((n) => sha20(n)),
  ...Array.from({ length: 500 }, (_, i) =>
    sha20(Buffer.concat([Buffer.from("ics20-1"), Buffer.from([0]), Buffer.from(`transfer/channel-${i}`)]))
  ),
]);

function roleOfKey(key: string): number {
  switch (key) {
    case "sender":
    case "spender":
    case "from":
    case "from_address":
    case "burner":
      return ROLE.sender;
    case "recipient":
    case "receiver":
    case "to":
    case "to_address":
    case "minter":
      return ROLE.recipient;
    case "delegator":
      return ROLE.delegator;
    case "validator":
    case "source_validator":
    case "destination_validator":
      return ROLE.validator;
    case "voter":
      return ROLE.voter;
    case "depositor":
      return ROLE.depositor;
    case "proposer":
      return ROLE.proposer;
    case "granter":
      return ROLE.granter;
    case "grantee":
      return ROLE.grantee;
    case "fee_payer":
      return ROLE.fee_payer;
    case "acc_seq":
      return ROLE.signer;
    default:
      return ROLE.other;
  }
}

class Parties {
  private readonly m = new Map<string, number>();
  add(address: string | null | undefined, role: number) {
    if (!address) return;
    const bytes = addressBytes(address);
    if (!bytes || MODULE_BYTES.has(bytes)) return;
    this.m.set(address, (this.m.get(address) ?? 0) | role);
  }
  rows(height: string, txHashValue: string): TxPartyRow[] {
    return [...this.m.entries()].map(([address, roles]) => ({ address, height, txHash: txHashValue, roles }));
  }
}

/** The account that owns a validator operator address (same bytes, other prefix). */
export function operatorAccount(operator: string, accountPrefix: string): string | null {
  try {
    const d = bech32.decode(operator, 256);
    return bech32.encode(accountPrefix, d.words);
  } catch {
    return null;
  }
}

/** The validator operator address of an account (same bytes, "…valoper" prefix). */
export function accountOperator(account: string): string | null {
  try {
    const d = bech32.decode(account, 256);
    if (/valoper$/.test(d.prefix)) return account;
    return bech32.encode(`${d.prefix}valoper`, d.words);
  } catch {
    return null;
  }
}

/** CometBFT consensus address of an ed25519 key: sha256(pubkey)[:20], uppercase hex. */
export function consAddressOf(pubkey: Uint8Array): string {
  return createHash("sha256").update(pubkey).digest().subarray(0, 20).toString("hex").toUpperCase();
}

/** The same consensus address in bech32, with the chain's valcons prefix. */
export function valconsOf(consHex: string, operator: string): string | null {
  try {
    const prefix = bech32.decode(operator, 256).prefix.replace(/valoper$/, "valcons");
    return bech32.encode(prefix, bech32.toWords(Buffer.from(consHex, "hex")));
  } catch {
    return null;
  }
}

// ── per-transaction extraction ───────────────────────────────────────────────

export interface ExtractedTx {
  tx: TxRow;
  transfers: TransferRow[];
  votes: VoteRow[];
  parties: TxPartyRow[];
  msgs: TxMsgRow[];
  ibc: IbcPacketRow[];
  staking: StakingEventRow[];
  deposits: GovDepositRow[];
  proposals: GovProposalRow[];
  unjails: SlashRow[];
  validatorKeys: ValidatorKeyRow[];
  /** How the events were grouped into messages; see events.ts. */
  grouping: string;
}

function stakingKind(type: string): StakingKind | null {
  switch (type) {
    case "delegate":
      return "delegate";
    case "unbond":
      return "undelegate";
    case "redelegate":
      return "redelegate";
    case "cancel_unbonding_delegation":
      return "cancel_unbonding";
    case "create_validator":
      return "create_validator";
    case "edit_validator":
      return "edit_validator";
    case "complete_unbonding":
      return "complete_unbonding";
    case "complete_redelegation":
      return "complete_redelegation";
    default:
      return null;
  }
}

function stakingRow(
  p: { type: string; a: Record<string, string>; seq: number; msgIndex: number | null; authzIndex: number | null },
  height: string,
  time: string,
  hash: string,
  fallbackActor: string | null
): StakingEventRow | null {
  const kind = stakingKind(p.type);
  if (!kind) return null;
  const a = p.a;
  const { amount, denom } = coinOrAmount(a.amount);
  const redelegation = kind === "redelegate" || kind === "complete_redelegation";
  return {
    height,
    time,
    txHash: hash,
    eventSeq: p.seq,
    kind,
    validator: (redelegation ? a.source_validator : a.validator) || null,
    validatorDst: redelegation ? a.destination_validator || null : null,
    // Older SDKs left the delegator out of the event; the message sender is it.
    delegator:
      a.delegator ||
      (kind === "create_validator" || kind === "edit_validator" ? null : fallbackActor),
    amount,
    denom,
    completionTime: a.completion_time || null,
    creationHeight: a.creation_height || null,
    msgIndex: p.msgIndex,
    authzMsgIndex: p.authzIndex,
  };
}

function parsePacketData(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return {};
    const out: Record<string, string> = {};
    for (const k of ["sender", "receiver", "denom", "amount", "memo"]) {
      if (typeof v[k] === "string") out[k] = v[k];
    }
    return out;
  } catch {
    return {};
  }
}

function ackResult(raw: string | undefined): { ok: boolean | null; error: string | null } {
  if (!raw) return { ok: null, error: null };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") {
      if (typeof v.error === "string") return { ok: false, error: v.error };
      if (v.result !== undefined) return { ok: true, error: null };
    }
  } catch {
    /* not JSON: a raw acknowledgement */
  }
  return { ok: null, error: null };
}

const IBC_CORE = /^\/ibc\.core\./;

/**
 * Rows for one transaction, from its raw bytes and its ABCI result.
 *
 * The `tx` event carries the fee and fee payer; `message` events carry the
 * message type per index; `transfer`, `withdraw_rewards` and
 * `withdraw_commission` carry the value that actually moved. Every value row is
 * keyed by the event that carried it, so two movements in one message — a
 * MultiSend's outputs, an authz batch's withdrawals — can never overwrite each
 * other the way (message, kind) keys let them.
 */
export function extractTx(
  rawBase64: string,
  result: TxResult,
  txIndex: number,
  height: string,
  time: string
): ExtractedTx {
  const hash = txHash(rawBase64);
  const { events, grouping } = placeEvents(result);
  const ok = (result.code ?? 0) === 0;
  const decoded = decodeTx(rawBase64);

  let feeDenom: string | null = null;
  let feeAmount: string | null = null;
  let feeCoins: Coin[] = [];
  let feePayer: string | null = null;
  const signers: string[] = [];
  const msgTypes: string[] = [];
  const transfers: TransferRow[] = [];
  const staking: StakingEventRow[] = [];
  const deposits: GovDepositRow[] = [];
  const proposals: GovProposalRow[] = [];
  const unjails: SlashRow[] = [];
  const ibc: IbcPacketRow[] = [];
  const parties = new Parties();

  // Who acted in each message group: the `message` event's sender. A MultiSend's
  // transfer events carry only the recipient, and pre-0.47 staking events leave
  // the delegator out; both are that message's sender.
  const actorOf = new Map<string, string>();
  const groupKey = (p: Placed) => `${p.msgIndex}|${p.authzIndex ?? ""}`;
  for (const p of events) {
    if (p.type === "message" && p.a.sender && !actorOf.has(groupKey(p))) {
      actorOf.set(groupKey(p), p.a.sender);
    }
  }
  // The input side of a transfer without a sender: the last coin_spent before it
  // in the same group, else the group's actor.
  let lastSpender: { key: string; spender: string } | null = null;

  const push = (
    p: Placed,
    kind: TransferKind,
    from: string | null,
    to: string | null,
    coins: { denom: string; amount: string }[]
  ) => {
    coins.forEach((c, coinIndex) => {
      // "0stake" is how the SDK spells an empty reward; nothing moved. 107,840
      // such rows were stored up to version 3. coinIndex keeps its position.
      if (/^0+$/.test(c.amount)) return;
      transfers.push({
        txHash: hash,
        eventSeq: p.seq,
        msgIndex: p.msgIndex,
        authzMsgIndex: p.authzIndex,
        coinIndex,
        height,
        time,
        kind,
        fromAddr: from,
        toAddr: to,
        denom: c.denom,
        amount: c.amount,
      });
    });
  };

  for (const p of events) {
    const a = p.a;

    // Every bech32 account or operator any event names is a party.
    for (const x of p.list) {
      if (x.key === "acc_seq") parties.add(x.value.split("/")[0], ROLE.signer);
      else parties.add(x.value, roleOfKey(x.key));
    }

    switch (p.type) {
      case "tx":
        if (a.fee !== undefined) {
          const coins = parseCoins(a.fee);
          feeCoins = coins;
          if (coins.length > 0) {
            feeDenom = coins[0].denom;
            feeAmount = coins[0].amount;
          }
        }
        if (a.fee_payer) feePayer = a.fee_payer;
        for (const x of p.list) {
          if (x.key === "acc_seq" && x.value) signers.push(x.value.split("/")[0]);
        }
        break;

      case "message":
        if (a.action && p.msgIndex >= 0 && p.authzIndex === null) msgTypes.push(a.action);
        break;

      case "coin_spent":
        if (a.spender) lastSpender = { key: groupKey(p), spender: a.spender };
        break;

      case "transfer":
        if (a.amount) {
          const from =
            a.sender ||
            (lastSpender && lastSpender.key === groupKey(p) ? lastSpender.spender : null) ||
            actorOf.get(groupKey(p)) ||
            null;
          push(p, p.msgIndex === -1 ? "fee" : "transfer", from, a.recipient || null, parseCoins(a.amount));
        }
        break;

      case "withdraw_rewards":
        // The amount lives only here — the MsgWithdrawDelegatorReward message
        // itself carries none, which is why the UI shows a dash for it today.
        if (a.amount) {
          push(p, "reward", a.validator || null, a.delegator || null, parseCoins(a.amount));
        }
        break;

      case "withdraw_commission":
        if (a.amount) {
          push(p, "commission", a.validator || null, null, parseCoins(a.amount));
        }
        break;

      case "proposal_deposit":
        if (ok && a.proposal_id) {
          const coins = parseCoins(a.amount ?? "");
          deposits.push({
            txHash: hash,
            eventSeq: p.seq,
            proposalId: a.proposal_id,
            depositor: a.depositor || actorOf.get(groupKey(p)) || null,
            coins,
            height,
            time,
          });
          if (a.depositor) parties.add(a.depositor, ROLE.depositor);
          else parties.add(actorOf.get(groupKey(p)), ROLE.depositor);
        }
        break;

      case "submit_proposal":
        if (ok && a.proposal_id) {
          const proposer = actorOf.get(groupKey(p)) ?? null;
          proposals.push({
            proposalId: a.proposal_id,
            submitHeight: height,
            submitTx: hash,
            submitTime: time,
            proposer,
            messages: a.proposal_messages
              ? a.proposal_messages.split(",").map((s) => s.trim()).filter(Boolean)
              : null,
          });
          parties.add(proposer, ROLE.proposer);
        }
        break;

      case "send_packet":
      case "recv_packet":
      case "write_acknowledgement":
      case "acknowledge_packet":
      case "timeout_packet": {
        if (!ok) break;
        const srcPort = a.packet_src_port;
        const srcChannel = a.packet_src_channel;
        const sequence = a.packet_sequence;
        if (!srcPort || !srcChannel || !sequence) break;
        const out = p.type === "send_packet" || p.type === "acknowledge_packet" || p.type === "timeout_packet";
        const row: IbcPacketRow = {
          direction: out ? "out" : "in",
          srcPort,
          srcChannel,
          sequence,
          dstPort: a.packet_dst_port || null,
          dstChannel: a.packet_dst_channel || null,
          connection: a.packet_connection || a.connection_id || null,
          timeoutHeight: a.packet_timeout_height || null,
          timeoutTimestamp: a.packet_timeout_timestamp || null,
        };
        const data = parsePacketData(a.packet_data);
        if (data.sender !== undefined) {
          row.sender = data.sender || null;
          row.receiver = data.receiver || null;
          row.denom = data.denom || null;
          row.amount = data.amount && /^\d+$/.test(data.amount) ? data.amount : null;
          row.memo = data.memo ?? null;
        }
        if (p.type === "send_packet") {
          row.sendHeight = height;
          row.sendTx = hash;
          row.sendTime = time;
        } else if (p.type === "recv_packet") {
          row.recvHeight = height;
          row.recvTx = hash;
          row.recvTime = time;
          row.recvRelayer = actorOf.get(groupKey(p)) ?? null;
        } else if (p.type === "write_acknowledgement") {
          const r = ackResult(a.packet_ack);
          row.ackOk = r.ok;
          row.ackError = r.error;
        } else if (p.type === "acknowledge_packet") {
          row.ackHeight = height;
          row.ackTx = hash;
          row.ackTime = time;
          row.ackRelayer = actorOf.get(groupKey(p)) ?? null;
        } else {
          row.timeoutAtHeight = height;
          row.timeoutTx = hash;
        }
        ibc.push(row);
        break;
      }

      case "fungible_token_packet": {
        // On the source chain this follows acknowledge_packet in the same message
        // and says whether the counterparty accepted the tokens.
        const prev = ibc[ibc.length - 1];
        if (prev && prev.ackTx === hash && prev.direction === "out") {
          if (a.success !== undefined) prev.ackOk = a.success === "true" || a.success === "\u0001";
          if (a.error) {
            prev.ackOk = false;
            prev.ackError = a.error;
          }
        }
        break;
      }

      default: {
        const kind = stakingKind(p.type);
        if (kind && ok) {
          const row = stakingRow(p, height, time, hash, actorOf.get(groupKey(p)) ?? null);
          if (row) staking.push(row);
        }
      }
    }
  }

  // ── from the bytes: messages (authz inner ones and failed transactions
  //    included), memo, fee granter ──
  const msgs: TxMsgRow[] = [];
  const validatorKeys: ValidatorKeyRow[] = [];
  let hasIbcCore = false;
  if (decoded) {
    decoded.messages.forEach((m, i) => {
      const sender = messageSender(m.value);
      msgs.push({ txHash: hash, height, msgIndex: i, innerIndex: -1, typeUrl: m.typeUrl, sender });
      // A message's own sender is a party even when no event names it: a
      // validator's operator address on MsgUnjail or MsgEditValidator.
      parties.add(sender, ROLE.sender);
      if (IBC_CORE.test(m.typeUrl)) hasIbcCore = true;
      if (m.typeUrl === MSG_EXEC) {
        execInner(m.value).forEach((inner, j) => {
          const innerSender = messageSender(inner.value);
          msgs.push({ txHash: hash, height, msgIndex: i, innerIndex: j, typeUrl: inner.typeUrl, sender: innerSender });
          parties.add(innerSender, ROLE.granter);
        });
        parties.add(sender, ROLE.grantee);
      }
      if (ok && m.typeUrl === "/cosmos.staking.v1beta1.MsgCreateValidator") {
        const k = createValidatorKey(m.value);
        if (k && /Ed25519|ed25519/.test(k.keyType)) {
          const consHex = consAddressOf(k.pubkey);
          const consValcons = valconsOf(consHex, k.operator);
          if (consValcons) validatorKeys.push({ operator: k.operator, consHex, consValcons, height });
        }
      }
      // An unjail names only the operator: no event carries a validator address.
      if (ok && m.typeUrl === "/cosmos.slashing.v1beta1.MsgUnjail" && sender) {
        const operator = accountOperator(sender);
        if (operator) {
          unjails.push({ height, time, consAddr: operator, operator, kind: "unjailed", reason: null, burned: null });
        }
      }
    });
    if (decoded.feeGranter) parties.add(decoded.feeGranter, ROLE.fee_granter);
  }

  const firstSigner = signers[0] ?? null;
  const signer = feePayer ?? firstSigner ?? msgs[0]?.sender ?? null;
  if (feePayer) parties.add(feePayer, ROLE.fee_payer);
  // The signer of a relay transaction is the relayer.
  if (hasIbcCore) for (const s of signers.length ? signers : signer ? [signer] : []) parties.add(s, ROLE.relayer);

  // Failed transactions ran no messages and emitted no actions: name their
  // top-level types from the bytes, so the type pills are never blank.
  const types = msgTypes.length > 0 ? msgTypes : msgs.filter((m) => m.innerIndex === -1).map((m) => m.typeUrl);

  // Fees: the event's list, else the bytes' (a tx that failed in the ante
  // handler may never have emitted its fee event).
  if (feeCoins.length === 0 && decoded && decoded.feeCoins.length > 0) {
    feeCoins = decoded.feeCoins;
    feeDenom = feeCoins[0].denom;
    feeAmount = feeCoins[0].amount;
  }

  const votes = ok ? extractVotes(result.events ?? [], hash, height, time) : [];
  for (const v of votes) parties.add(v.voter, ROLE.voter);

  return {
    tx: {
      hash,
      height,
      txIndex,
      time,
      code: result.code ?? 0,
      codespace: result.codespace || null,
      feeDenom,
      feeAmount,
      feeCoins,
      gasUsed: result.gas_used ?? null,
      gasWanted: result.gas_wanted ?? null,
      signer,
      signers,
      feeGranter: decoded?.feeGranter ?? null,
      memo: decoded ? decoded.memo : null,
      msgTypes: types,
    },
    transfers,
    votes,
    parties: parties.rows(height, hash),
    msgs,
    ibc,
    staking,
    deposits,
    proposals,
    unjails,
    validatorKeys,
    grouping,
  };
}

/** The consensus address of a validator update's key, uppercase hex. */
function updateConsAddr(u: ValidatorUpdate): string | null {
  const b64 = u.pub_key?.Sum?.value?.ed25519 ?? (u.pub_key?.type?.includes("Ed25519") ? u.pub_key.value : undefined);
  if (!b64) return null;
  return consAddressOf(Buffer.from(b64, "base64"));
}

function proposalOutcome(result: string | undefined): string | null {
  if (!result) return null;
  const m = /^proposal_(passed|rejected|failed|dropped)$/.exec(result);
  return m ? m[1] : result;
}

/**
 * Everything one height contributes.
 *
 * Returns null when the two responses disagree about the height or the block is
 * missing — better to skip and retry than to write a half-formed height.
 */
export function extractBlock(
  block: BlockResponse,
  results: BlockResultsResponse,
  /**
   * Resolved by the caller, which owns the validator-set cache and the
   * network. Defaulted so this stays a pure function over fixtures in tests.
   */
  missed: MissedSignatureRow[] = []
): ExtractedBlock | null {
  const header = block.result?.block?.header;
  const height = header?.height;
  const time = header?.time;
  if (!height || !time) return null;

  const resultsHeight = results.result?.height;
  if (resultsHeight && resultsHeight !== height) return null;

  const rawTxs = block.result?.block?.data?.txs ?? [];
  const txResults = results.result?.txs_results ?? [];
  const abciResultsMissing = rawTxs.length > 0 && txResults.length === 0;

  const out: ExtractedBlock = {
    block: {
      height,
      time,
      proposerCons: header?.proposer_address ?? null,
      hash: block.result?.block_id?.hash ?? null,
      txCount: rawTxs.length,
    },
    txs: [],
    transfers: [],
    votes: [],
    slashes: [],
    missed,
    txParties: [],
    txMsgs: [],
    ibcPackets: [],
    stakingEvents: [],
    validatorPower: [],
    govDeposits: [],
    govProposals: [],
    validatorKeys: [],
    abciResultsMissing,
    extractVersion: abciResultsMissing ? 0 : EXTRACT_VERSION,
  };

  rawTxs.forEach((raw, i) => {
    // A block whose results have not caught up would pair txs with the wrong
    // result; an empty result is safer than a mismatched one.
    const result = txResults[i] ?? {};
    const x = extractTx(raw, result, i, height, time);
    out.txs.push(x.tx);
    out.transfers.push(...x.transfers);
    out.votes.push(...x.votes);
    out.txParties.push(...x.parties);
    out.txMsgs.push(...x.msgs);
    out.ibcPackets.push(...x.ibc);
    out.stakingEvents.push(...x.staking);
    out.govDeposits.push(...x.deposits);
    out.govProposals.push(...x.proposals);
    out.slashes.push(...x.unjails);
    out.validatorKeys.push(...x.validatorKeys);
  });

  // Slashing, unbonding completions and proposal outcomes live in the block's
  // own events, never in a transaction.
  const bev = blockEvents(results);
  out.slashes.push(...extractSlashes(bev, height, time));
  bev.forEach((ev, seq) => {
    const a = attrs(ev);
    if (ev.type === "complete_unbonding" || ev.type === "complete_redelegation") {
      const row = stakingRow({ type: ev.type, a, seq, msgIndex: null, authzIndex: null }, height, time, "", null);
      if (row) out.stakingEvents.push(row);
    } else if ((ev.type === "active_proposal" || ev.type === "inactive_proposal") && a.proposal_id) {
      out.govProposals.push({
        proposalId: a.proposal_id,
        outcome: proposalOutcome(a.proposal_result),
        outcomeHeight: height,
        outcomeTime: time,
      });
    }
  });

  for (const u of results.result?.validator_updates ?? []) {
    const consAddr = updateConsAddr(u);
    if (consAddr) out.validatorPower.push({ height, consAddr, power: u.power ?? "0" });
  }

  return out;
}
