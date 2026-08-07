/**
 * Who a transaction message moved value between, and how much.
 *
 * The Cosmos REST API returns each message as a bare JSON object whose fields
 * depend entirely on its type — there is no common "from/to/amount" shape — so
 * the interesting types are mapped explicitly. Anything unmapped yields null
 * and the UI shows the message label alone rather than guessing.
 */

export interface Coin {
  denom: string;
  amount: string;
}

export interface TxTransfer {
  /** Where value left. */
  from: string | null;
  /** Where it arrived. A validator operator address for staking messages. */
  to: string | null;
  amount: Coin[];
  /**
   * True when `from`/`to` are a delegator and a validator rather than two
   * accounts, so the UI can label the direction properly.
   */
  staking: boolean;
}

/** A raw message: shape varies by type, so every field is optional. */
export interface RawMessage {
  "@type": string;
  from_address?: string;
  to_address?: string;
  delegator_address?: string;
  validator_address?: string;
  validator_src_address?: string;
  validator_dst_address?: string;
  sender?: string;
  receiver?: string;
  voter?: string;
  granter?: string;
  grantee?: string;
  amount?: Coin[] | Coin;
  token?: Coin;
  inputs?: { address?: string; coins?: Coin[] }[];
  outputs?: { address?: string; coins?: Coin[] }[];
  /** authz MsgExec carries the messages it runs on the granter's behalf. */
  msgs?: RawMessage[];
}

const MAX_AUTHZ_DEPTH = 4;

/**
 * Flatten authz wrappers so nested messages are seen.
 *
 * Same trap as governance votes: a MsgExec hides the real message one level
 * down, and reading only the top level makes those transactions look empty.
 */
export function flattenMessages(
  messages: RawMessage[] | undefined,
  depth = 0
): RawMessage[] {
  if (!messages || depth > MAX_AUTHZ_DEPTH) return [];
  const out: RawMessage[] = [];
  for (const msg of messages) {
    if (/MsgExec$/.test(msg["@type"]) && msg.msgs) {
      out.push(...flattenMessages(msg.msgs, depth + 1));
    } else {
      out.push(msg);
    }
  }
  return out;
}

/** `amount` is a list on MsgSend but a single coin on MsgDelegate. */
function coins(value: Coin[] | Coin | undefined): Coin[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function transferOf(msg: RawMessage): TxTransfer | null {
  const type = msg["@type"].split(".").pop() ?? "";

  switch (type) {
    case "MsgSend":
      return {
        from: msg.from_address ?? null,
        to: msg.to_address ?? null,
        amount: coins(msg.amount),
        staking: false,
      };

    case "MsgMultiSend": {
      // Many-to-many. One row cannot honestly show it, so it reports the first
      // input and leaves the recipient null rather than picking one arbitrarily.
      const first = msg.inputs?.[0];
      return {
        from: first?.address ?? null,
        to: null,
        amount: first?.coins ?? [],
        staking: false,
      };
    }

    case "MsgDelegate":
      return {
        from: msg.delegator_address ?? null,
        to: msg.validator_address ?? null,
        amount: coins(msg.amount),
        staking: true,
      };

    case "MsgUndelegate":
      // Value flows back out of the validator.
      return {
        from: msg.validator_address ?? null,
        to: msg.delegator_address ?? null,
        amount: coins(msg.amount),
        staking: true,
      };

    case "MsgBeginRedelegate":
      return {
        from: msg.validator_src_address ?? null,
        to: msg.validator_dst_address ?? null,
        amount: coins(msg.amount),
        staking: true,
      };

    case "MsgWithdrawDelegatorReward":
      // The amount is not in the message — it is only in the events — so this
      // shows the parties and no figure rather than an invented one.
      return {
        from: msg.validator_address ?? null,
        to: msg.delegator_address ?? null,
        amount: [],
        staking: true,
      };

    case "MsgTransfer":
      return {
        from: msg.sender ?? null,
        to: msg.receiver ?? null,
        amount: coins(msg.token),
        staking: false,
      };

    default:
      return null;
  }
}

/**
 * The transfer that best represents a whole transaction, for a one-line summary.
 *
 * Picks the first message that moved a non-zero amount, falling back to the
 * first that at least names both parties.
 */
export function primaryTransfer(
  messages: RawMessage[] | undefined
): TxTransfer | null {
  const flat = flattenMessages(messages);
  const transfers = flat.map(transferOf).filter((t): t is TxTransfer => t !== null);
  return (
    transfers.find((t) => t.amount.length > 0) ??
    transfers.find((t) => t.from || t.to) ??
    null
  );
}

/**
 * Which way value moved relative to an address, for an account's own history.
 * Null when the address is not a party — a vote or a grant, say.
 */
export function directionFor(
  transfer: TxTransfer | null,
  address: string
): "in" | "out" | "self" | null {
  if (!transfer) return null;
  const from = transfer.from === address;
  const to = transfer.to === address;
  if (from && to) return "self";
  if (from) return "out";
  if (to) return "in";
  return null;
}
