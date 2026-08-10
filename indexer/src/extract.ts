import { createHash } from "node:crypto";

/**
 * Turn one block's RPC responses into rows.
 *
 * Pure functions over the JSON the node returns — no network, no database — so
 * the whole extraction is testable against captured fixtures.
 *
 * Everything comes from `/block` and `/block_results`. Notably we never call
 * tx-search, so this works against a node with `tx_index: off`, and we never
 * decode protobuf: the ABCI events carry more than the messages do (a reward
 * withdrawal's *amount* exists only in the event).
 */

/**
 * Which facts this extractor pulls out of a block.
 *
 * Stored on every block row so a reader can tell "we have this block" apart
 * from "we have everything this block contained". Those diverged once already:
 * blocks written before votes were extracted looked complete, so a proposal
 * spanning them reported a fraction of its votes as though that were the total.
 *
 * Bump this whenever a new kind of row starts being extracted, and refill.
 *
 *   1  fees and transfers
 *   2  + governance votes and slashing events
 */
export const EXTRACT_VERSION = 2;

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
  gas_used?: string;
  gas_wanted?: string;
  events?: Event[];
}

export interface BlockResponse {
  result?: {
    block_id?: { hash?: string };
    block?: {
      header?: { height?: string; time?: string; proposer_address?: string };
      data?: { txs?: string[] | null };
    };
  };
}

export interface BlockResultsResponse {
  result?: {
    height?: string;
    txs_results?: TxResult[] | null;
    /** CometBFT 0.38+. Older nodes split this into begin/end_block_events. */
    finalize_block_events?: Event[] | null;
    begin_block_events?: Event[] | null;
    end_block_events?: Event[] | null;
  };
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
  feeDenom: string | null;
  feeAmount: string | null;
  gasUsed: string | null;
  gasWanted: string | null;
  signer: string | null;
  msgTypes: string[];
}

export type TransferKind = "transfer" | "reward" | "commission" | "fee";

export interface TransferRow {
  txHash: string;
  msgIndex: number;
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
}

export type SlashKind = "slashed" | "jailed" | "unjailed" | "tombstoned";

export interface SlashRow {
  height: string;
  time: string;
  /** Consensus address, bech32 valcons — the only identity the events carry. */
  consAddr: string;
  kind: SlashKind;
  /** downtime | double_sign, when the chain says. */
  reason: string | null;
  burned: string | null;
}

export interface ExtractedBlock {
  block: BlockRow;
  txs: TxRow[];
  transfers: TransferRow[];
  votes: VoteRow[];
  slashes: SlashRow[];
  /**
   * The block has transactions but the node returned no ABCI results for them.
   *
   * Symptom of `discard_abci_responses = true`, or of an archive that pruned
   * responses beyond a window. The rows are then hollow — no fee, no signer, no
   * transfers — which looks like a quiet success rather than missing data, so
   * the worker surfaces it instead of writing on silently.
   */
  abciResultsMissing: boolean;
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
 * grantee, the exact bug that made the explorer under-count AtomOne proposals.
 */
export function extractVotes(
  events: Event[],
  txHashValue: string,
  height: string,
  time: string
): VoteRow[] {
  const out: VoteRow[] = [];

  for (const event of events) {
    if (event.type !== "proposal_vote") continue;
    const a = attrs(event);
    const proposalId = a.proposal_id;
    const voter = a.voter;
    if (!proposalId || !voter) continue;

    const options = parseVoteOptions(a.option ?? "");
    if (options.length === 0) continue;

    // Heaviest option represents the vote; ties keep the first, which matches
    // how the explorer already summarises weighted votes.
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
    });
  }

  return out;
}

/**
 * Jailing, slashing and tombstoning, from a block's own events.
 *
 * This is the data no node can serve after the fact: slashing happens in
 * BeginBlock rather than a transaction, so it is absent from tx search, and the
 * module keeps only a current `jailed_until` with no history.
 *
 * Deliberately ignores `liveness`, which fires every block for every validator
 * carrying a missed-block counter — a running total, not an event, and
 * enormous at chain scale.
 */
export function extractSlashes(
  events: Event[],
  height: string,
  time: string
): SlashRow[] {
  const out: SlashRow[] = [];

  for (const event of events) {
    if (event.type !== "slash") continue;
    const a = attrs(event);
    const consAddr = a.address;
    if (!consAddr) continue;

    // "missing_signature" is the chain's wording; "downtime" is the reader's.
    const reason =
      a.reason === "missing_signature"
        ? "downtime"
        : a.reason === "double_sign"
          ? "double_sign"
          : (a.reason ?? null);

    out.push({
      height,
      time,
      consAddr,
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
        // Double-signing tombstones permanently; downtime only jails.
        kind: reason === "double_sign" ? "tombstoned" : "jailed",
        reason,
        burned: null,
      });
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

/**
 * Rows for one transaction, from its raw bytes and its ABCI result.
 *
 * The `tx` event carries the fee and fee payer; `message` events carry the
 * message type per index; `transfer`, `withdraw_rewards` and
 * `withdraw_commission` carry the value that actually moved.
 */
export function extractTx(
  rawBase64: string,
  result: TxResult,
  txIndex: number,
  height: string,
  time: string
): { tx: TxRow; transfers: TransferRow[] } {
  const hash = txHash(rawBase64);
  const events = result.events ?? [];

  let feeDenom: string | null = null;
  let feeAmount: string | null = null;
  let signer: string | null = null;
  const msgTypes: string[] = [];
  const transfers: TransferRow[] = [];

  // A message index is only present once the chain is executing messages; the
  // fee deduction happens before that and carries none.
  const indexOf = (a: Record<string, string>) =>
    a.msg_index === undefined ? -1 : Number(a.msg_index);

  const push = (
    kind: TransferKind,
    msgIndex: number,
    from: string | null,
    to: string | null,
    coins: { denom: string; amount: string }[]
  ) => {
    coins.forEach((c, coinIndex) => {
      transfers.push({
        txHash: hash,
        msgIndex,
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

  for (const ev of events) {
    const a = attrs(ev);

    switch (ev.type) {
      case "tx":
        if (a.fee) {
          // The fee may be several coins; the tx row records the first, which
          // is the fee token in practice. The full set lands in `transfer`.
          const coins = parseCoins(a.fee);
          if (coins.length > 0) {
            feeDenom = coins[0].denom;
            feeAmount = coins[0].amount;
          }
        }
        if (a.fee_payer) signer = a.fee_payer;
        break;

      case "message":
        if (a.action) msgTypes.push(a.action);
        // Falls back to the message sender when no explicit fee payer appeared.
        if (!signer && a.sender) signer = a.sender;
        break;

      case "transfer":
        if (a.amount) {
          const msgIndex = indexOf(a);
          push(
            msgIndex === -1 ? "fee" : "transfer",
            msgIndex,
            a.sender ?? null,
            a.recipient ?? null,
            parseCoins(a.amount)
          );
        }
        break;

      case "withdraw_rewards":
        // The amount lives only here — the MsgWithdrawDelegatorReward message
        // itself carries none, which is why the UI shows a dash for it today.
        if (a.amount) {
          push(
            "reward",
            indexOf(a),
            a.validator ?? null,
            a.delegator ?? null,
            parseCoins(a.amount)
          );
        }
        break;

      case "withdraw_commission":
        if (a.amount) {
          push("commission", indexOf(a), a.validator ?? null, null, parseCoins(a.amount));
        }
        break;
    }
  }

  return {
    tx: {
      hash,
      height,
      txIndex,
      time,
      code: result.code ?? 0,
      feeDenom,
      feeAmount,
      gasUsed: result.gas_used ?? null,
      gasWanted: result.gas_wanted ?? null,
      signer,
      msgTypes,
    },
    transfers,
  };
}

/**
 * Everything one height contributes.
 *
 * Returns null when the two responses disagree about the height or the block is
 * missing — better to skip and retry than to write a half-formed height.
 */
export function extractBlock(
  block: BlockResponse,
  results: BlockResultsResponse
): ExtractedBlock | null {
  const header = block.result?.block?.header;
  const height = header?.height;
  const time = header?.time;
  if (!height || !time) return null;

  const resultsHeight = results.result?.height;
  if (resultsHeight && resultsHeight !== height) return null;

  const rawTxs = block.result?.block?.data?.txs ?? [];
  const txResults = results.result?.txs_results ?? [];

  const txs: TxRow[] = [];
  const transfers: TransferRow[] = [];
  const votes: VoteRow[] = [];

  rawTxs.forEach((raw, i) => {
    // A block whose results have not caught up would pair txs with the wrong
    // result; an empty result is safer than a mismatched one.
    const result = txResults[i] ?? {};
    const extracted = extractTx(raw, result, i, height, time);
    txs.push(extracted.tx);
    transfers.push(...extracted.transfers);

    // Only successful transactions cast votes; a failed one emits no
    // proposal_vote event, but checking the code makes that explicit.
    if ((result.code ?? 0) === 0) {
      votes.push(
        ...extractVotes(result.events ?? [], extracted.tx.hash, height, time)
      );
    }
  });

  // Slashing lives in the block's own events, never in a transaction.
  const slashes = extractSlashes(blockEvents(results), height, time);

  return {
    block: {
      height,
      time,
      proposerCons: header?.proposer_address ?? null,
      hash: block.result?.block_id?.hash ?? null,
      txCount: rawTxs.length,
    },
    txs,
    transfers,
    votes,
    slashes,
    // `txs_results: null` with transactions present means the node dropped its
    // ABCI responses for this height.
    abciResultsMissing: rawTxs.length > 0 && txResults.length === 0,
  };
}
