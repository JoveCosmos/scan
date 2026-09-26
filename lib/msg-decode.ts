/**
 * What a transaction message says, as labelled fields.
 *
 * The REST API returns each message as a bare JSON object whose shape depends
 * entirely on its type. Each type we know gets a decoder that names its parties
 * by role — delegator, validator, voter, contract — rather than as a positional
 * from/to, so a page can label and link them correctly. A type we don't know
 * falls back to its type URL and its JSON.
 *
 * Pure on purpose (no server imports): the transaction page, the transactions
 * list and proposal pages all decode with it, some in the browser.
 */

export interface Coin {
  denom: string;
  amount: string;
}

export type FieldValue =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "address"; address: string }
  | { kind: "link"; text: string; href: string; mono?: boolean }
  | { kind: "coins"; coins: Coin[] }
  | { kind: "json"; json: string };

export interface DecodedField {
  label: string;
  value: FieldValue;
}

export interface DecodedMessage {
  typeUrl: string;
  label: string;
  fields: DecodedField[];
  /** Messages an authz MsgExec runs on the granter's behalf. */
  inner?: DecodedMessage[];
}

/** A plain row, the shape PopupRows and BrickBoard detail rows take. */
export interface DecodedRow {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
  address?: string;
}

export interface DecodeContext {
  /**
   * Events emitted by this message, keyed by type, attributes flattened. Fills
   * in what the message itself doesn't carry: rewards claimed, tokens swapped.
   */
  events?: { type: string; attributes: Record<string, string> }[];
  /** For rows: formats coins. Without it amounts show in base units. */
  formatCoins?: (coins: Coin[]) => string;
}

const LABELS: Record<string, string> = {
  MsgSend: "Send",
  MsgMultiSend: "Multi Send",
  MsgDelegate: "Delegate",
  MsgUndelegate: "Undelegate",
  MsgBeginRedelegate: "Redelegate",
  MsgCancelUnbondingDelegation: "Cancel Unbonding",
  MsgWithdrawDelegatorReward: "Claim Rewards",
  MsgWithdrawValidatorCommission: "Claim Commission",
  MsgSetWithdrawAddress: "Set Withdraw Address",
  MsgFundCommunityPool: "Fund Community Pool",
  MsgVote: "Vote",
  MsgVoteWeighted: "Weighted Vote",
  MsgDeposit: "Deposit",
  MsgSubmitProposal: "Submit Proposal",
  MsgTransfer: "IBC Transfer",
  MsgUpdateClient: "IBC Update Client",
  MsgAcknowledgement: "IBC Acknowledgement",
  MsgRecvPacket: "IBC Receive",
  MsgTimeout: "IBC Timeout",
  MsgTimeoutOnClose: "IBC Timeout",
  MsgExecuteContract: "Execute Contract",
  MsgInstantiateContract: "Instantiate Contract",
  MsgInstantiateContract2: "Instantiate Contract",
  MsgStoreCode: "Store Code",
  MsgMigrateContract: "Migrate Contract",
  MsgExec: "Authz Exec",
  MsgGrant: "Authz Grant",
  MsgRevoke: "Authz Revoke",
  MsgGrantAllowance: "Fee Grant",
  MsgRevokeAllowance: "Revoke Fee Grant",
  MsgCreateValidator: "Create Validator",
  MsgEditValidator: "Edit Validator",
  MsgUnjail: "Unjail",
  MsgSwapExactAmountIn: "Swap",
  MsgSwapExactAmountOut: "Swap",
  MsgSplitRouteSwapExactAmountIn: "Swap",
  MsgSplitRouteSwapExactAmountOut: "Swap",
};

/** "/cosmos.bank.v1beta1.MsgSend" -> "Send" (falling back to the bare type name). */
export function labelForType(typeUrl: string): string {
  const name = typeUrl.split(".").pop() ?? typeUrl;
  if (LABELS[name]) return LABELS[name];
  return name.replace(/^Msg/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function typeName(typeUrl: string): string {
  return typeUrl.split(".").pop() ?? typeUrl;
}

/** Messages that only exist to carry relayed data; never the "point" of a tx. */
export function isBookkeeping(typeUrl: string): boolean {
  return /MsgUpdateClient$/.test(typeUrl);
}

// ---------------------------------------------------------------- helpers

/** Base64 to UTF-8 text, in Node and the browser alike. Throws on bad input. */
export function b64utf8(s: string): string {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw new Error("not base64");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;

function coinList(v: unknown): Coin[] {
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter(
    (c): c is Coin =>
      !!c && typeof c === "object" && typeof (c as Coin).denom === "string" &&
      typeof (c as Coin).amount === "string"
  );
}

/** "498364uatom,12ibc/ABC" -> coins. */
export function parseCoinString(s: string | undefined | null): Coin[] {
  if (!s) return [];
  return s
    .split(",")
    .map((part) => part.trim().match(/^(\d+)(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ amount: m[1], denom: m[2] }));
}

function addr(label: string, v: unknown): DecodedField[] {
  const a = str(v);
  return a ? [{ label, value: { kind: "address", address: a } }] : [];
}

function text(label: string, v: unknown, mono = false): DecodedField[] {
  const t = str(v);
  return t ? [{ label, value: { kind: "text", text: t, mono } }] : [];
}

function coinsField(label: string, coins: Coin[]): DecodedField[] {
  return coins.length ? [{ label, value: { kind: "coins", coins } }] : [];
}

function jsonField(label: string, v: unknown): DecodedField[] {
  if (v === undefined || v === null || v === "") return [];
  let value = v;
  // CosmWasm messages sometimes arrive as base64 JSON; show the JSON.
  if (typeof v === "string") {
    try {
      value = JSON.parse(b64utf8(v));
    } catch {
      try {
        value = JSON.parse(v);
      } catch {
        value = v;
      }
    }
  }
  return [{ label, value: { kind: "json", json: prettyJson(value) } }];
}

/** Pretty JSON with any very long string (wasm bytecode, proofs) elided. */
export function prettyJson(value: unknown, maxString = 600): string {
  return JSON.stringify(
    value,
    (_k, v) =>
      typeof v === "string" && v.length > maxString
        ? `${v.slice(0, 80)}… (${v.length.toLocaleString()} chars)`
        : v,
    2
  );
}

const VOTE_OPTIONS: Record<string, string> = {
  VOTE_OPTION_YES: "Yes",
  VOTE_OPTION_NO: "No",
  VOTE_OPTION_ABSTAIN: "Abstain",
  VOTE_OPTION_NO_WITH_VETO: "No with veto",
  "1": "Yes",
  "2": "Abstain",
  "3": "No",
  "4": "No with veto",
};

function proposalLink(chainId: string, id: unknown): DecodedField[] {
  const n = str(id);
  if (!n) return [];
  return [
    {
      label: "Proposal",
      value: { kind: "link", text: `#${n}`, href: `/${chainId}/proposals/${n}`, mono: true },
    },
  ];
}

function eventsOf(ctx: DecodeContext | undefined, type: string) {
  return (ctx?.events ?? []).filter((e) => e.type === type);
}

/** Rewards claimed by this message (explicitly or on a stake change). */
function rewardsFrom(ctx: DecodeContext | undefined, delegator?: string | null): Coin[] {
  const coins: Coin[] = [];
  for (const e of eventsOf(ctx, "withdraw_rewards")) {
    if (delegator && e.attributes.delegator && e.attributes.delegator !== delegator) continue;
    coins.push(...parseCoinString(e.attributes.amount));
  }
  return mergeCoins(coins);
}

export function mergeCoins(coins: Coin[]): Coin[] {
  const by = new Map<string, bigint>();
  for (const c of coins) {
    if (!/^\d+$/.test(c.amount)) continue;
    by.set(c.denom, (by.get(c.denom) ?? BigInt(0)) + BigInt(c.amount));
  }
  return [...by].filter(([, a]) => a > BigInt(0)).map(([denom, a]) => ({ denom, amount: a.toString() }));
}

/** ICS-20 packet data, base64 JSON inside a relayed packet. */
export function decodePacketData(
  data: unknown
): { sender?: string; receiver?: string; amount?: string; denom?: string; memo?: string } | null {
  const s = str(data);
  if (!s) return null;
  for (const decode of [
    () => JSON.parse(b64utf8(s)),
    () => JSON.parse(s),
  ]) {
    try {
      const v = decode();
      if (v && typeof v === "object") return v;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ---------------------------------------------------------------- decoders

function decodeFields(chainId: string, name: string, m: Raw, ctx?: DecodeContext): DecodedField[] {
  switch (name) {
    case "MsgSend":
      return [
        ...addr("From", m.from_address),
        ...addr("To", m.to_address),
        ...coinsField("Amount", coinList(m.amount)),
      ];

    case "MsgMultiSend": {
      const out: DecodedField[] = [];
      for (const io of (m.inputs as Raw[] | undefined) ?? []) {
        out.push(...addr("Input", io.address), ...coinsField("Input amount", coinList(io.coins)));
      }
      for (const io of (m.outputs as Raw[] | undefined) ?? []) {
        out.push(...addr("Output", io.address), ...coinsField("Output amount", coinList(io.coins)));
      }
      return out;
    }

    case "MsgDelegate":
      return [
        ...addr("Delegator", m.delegator_address),
        ...addr("Validator", m.validator_address),
        ...coinsField("Amount", coinList(m.amount)),
        ...coinsField("Rewards claimed", rewardsFrom(ctx, str(m.delegator_address))),
      ];

    case "MsgUndelegate": {
      const completion = eventsOf(ctx, "unbond")[0]?.attributes.completion_time;
      return [
        ...addr("Delegator", m.delegator_address),
        ...addr("Validator", m.validator_address),
        ...coinsField("Amount", coinList(m.amount)),
        ...coinsField("Rewards claimed", rewardsFrom(ctx, str(m.delegator_address))),
        ...text("Completes", completion, true),
      ];
    }

    case "MsgBeginRedelegate": {
      const completion = eventsOf(ctx, "redelegate")[0]?.attributes.completion_time;
      return [
        ...addr("Delegator", m.delegator_address),
        ...addr("From validator", m.validator_src_address),
        ...addr("To validator", m.validator_dst_address),
        ...coinsField("Amount", coinList(m.amount)),
        ...coinsField("Rewards claimed", rewardsFrom(ctx, str(m.delegator_address))),
        ...text("Completes", completion, true),
      ];
    }

    case "MsgCancelUnbondingDelegation":
      return [
        ...addr("Delegator", m.delegator_address),
        ...addr("Validator", m.validator_address),
        ...coinsField("Amount", coinList(m.amount)),
        ...text("Creation height", m.creation_height, true),
      ];

    case "MsgWithdrawDelegatorReward":
      return [
        ...addr("Delegator", m.delegator_address),
        ...addr("Validator", m.validator_address),
        ...coinsField("Rewards", rewardsFrom(ctx, str(m.delegator_address))),
      ];

    case "MsgWithdrawValidatorCommission": {
      const coins = mergeCoins(
        eventsOf(ctx, "withdraw_commission").flatMap((e) => parseCoinString(e.attributes.amount))
      );
      return [...addr("Validator", m.validator_address), ...coinsField("Commission", coins)];
    }

    case "MsgSetWithdrawAddress":
      return [
        ...addr("Delegator", m.delegator_address),
        ...addr("Withdraw address", m.withdraw_address),
      ];

    case "MsgFundCommunityPool":
      return [...addr("Depositor", m.depositor), ...coinsField("Amount", coinList(m.amount))];

    case "MsgVote":
      return [
        ...proposalLink(chainId, m.proposal_id),
        ...addr("Voter", m.voter),
        ...text("Option", VOTE_OPTIONS[str(m.option) ?? ""] ?? m.option),
      ];

    case "MsgVoteWeighted": {
      const opts = ((m.options as Raw[] | undefined) ?? [])
        .map((o) => {
          const w = Number(str(o.weight) ?? "0");
          return `${VOTE_OPTIONS[str(o.option) ?? ""] ?? o.option} ${(w * 100).toFixed(0)}%`;
        })
        .join(", ");
      return [...proposalLink(chainId, m.proposal_id), ...addr("Voter", m.voter), ...text("Options", opts)];
    }

    case "MsgDeposit":
      return [
        ...proposalLink(chainId, m.proposal_id),
        ...addr("Depositor", m.depositor),
        ...coinsField("Amount", coinList(m.amount)),
      ];

    case "MsgSubmitProposal": {
      const submitted = eventsOf(ctx, "submit_proposal")[0]?.attributes.proposal_id;
      const content = (m.content as Raw | undefined) ?? undefined;
      return [
        ...proposalLink(chainId, submitted),
        ...addr("Proposer", m.proposer),
        ...text("Title", m.title ?? content?.title),
        ...coinsField("Initial deposit", coinList(m.initial_deposit)),
        ...(Array.isArray(m.messages) && m.messages.length
          ? text(
              "Proposal messages",
              (m.messages as Raw[]).map((x) => labelForType(String(x["@type"] ?? ""))).join(", ")
            )
          : []),
      ];
    }

    case "MsgTransfer": {
      const send = eventsOf(ctx, "send_packet")[0]?.attributes;
      return [
        ...addr("Sender", m.sender),
        ...addr("Receiver", m.receiver),
        ...coinsField("Amount", coinList(m.token)),
        ...text("Source channel", `${str(m.source_port) ?? "transfer"}/${str(m.source_channel) ?? "?"}`, true),
        ...text("Sequence", send?.packet_sequence, true),
        ...text("Timeout", timeoutText(m), true),
        ...memoField(m.memo),
      ];
    }

    case "MsgRecvPacket":
    case "MsgAcknowledgement":
    case "MsgTimeout":
    case "MsgTimeoutOnClose": {
      const p = (m.packet as Raw | undefined) ?? {};
      const data = decodePacketData(p.data);
      const ack = name === "MsgAcknowledgement" ? ackResult(m.acknowledgement) : null;
      return [
        ...text("Sequence", p.sequence, true),
        ...text("Source", `${str(p.source_port) ?? "?"}/${str(p.source_channel) ?? "?"}`, true),
        ...text("Destination", `${str(p.destination_port) ?? "?"}/${str(p.destination_channel) ?? "?"}`, true),
        ...addr("Packet sender", data?.sender),
        ...addr("Packet receiver", data?.receiver),
        ...(data?.amount && data?.denom
          ? coinsField("Packet amount", [{ amount: data.amount, denom: data.denom }])
          : []),
        ...text("Packet memo", data?.memo),
        ...(ack ? text("Result", ack) : []),
        ...addr("Relayer", m.signer),
      ];
    }

    case "MsgUpdateClient":
      return [...text("Client", m.client_id, true), ...addr("Relayer", m.signer)];

    case "MsgExecuteContract":
      return [
        ...addr("Sender", m.sender),
        ...addr("Contract", m.contract),
        ...coinsField("Funds", coinList(m.funds)),
        ...jsonField("Message", m.msg),
      ];

    case "MsgInstantiateContract":
    case "MsgInstantiateContract2": {
      const created = eventsOf(ctx, "instantiate")[0]?.attributes._contract_address;
      return [
        ...addr("Sender", m.sender),
        ...text("Code id", m.code_id, true),
        ...text("Label", m.label),
        ...addr("Admin", m.admin),
        ...addr("Contract", created),
        ...coinsField("Funds", coinList(m.funds)),
        ...jsonField("Message", m.msg),
      ];
    }

    case "MsgStoreCode": {
      const codeId = eventsOf(ctx, "store_code")[0]?.attributes.code_id;
      return [...addr("Sender", m.sender), ...text("Code id", codeId, true)];
    }

    case "MsgMigrateContract":
      return [
        ...addr("Sender", m.sender),
        ...addr("Contract", m.contract),
        ...text("New code id", m.code_id, true),
        ...jsonField("Message", m.msg),
      ];

    case "MsgExec":
      return addr("Grantee", m.grantee);

    case "MsgGrant": {
      const grant = (m.grant as Raw | undefined) ?? {};
      const auth = (grant.authorization as Raw | undefined) ?? {};
      return [
        ...addr("Granter", m.granter),
        ...addr("Grantee", m.grantee),
        ...text("Authorization", labelForType(String(auth["@type"] ?? "")) || null),
        ...text("Message", auth.msg, true),
        ...text("Expires", grant.expiration, true),
      ];
    }

    case "MsgRevoke":
      return [
        ...addr("Granter", m.granter),
        ...addr("Grantee", m.grantee),
        ...text("Message", m.msg_type_url, true),
      ];

    case "MsgGrantAllowance":
    case "MsgRevokeAllowance":
      return [...addr("Granter", m.granter), ...addr("Grantee", m.grantee)];

    case "MsgCreateValidator": {
      const d = (m.description as Raw | undefined) ?? {};
      const c = (m.commission as Raw | undefined) ?? {};
      return [
        ...text("Moniker", d.moniker),
        ...addr("Validator", m.validator_address),
        ...addr("Delegator", m.delegator_address),
        ...coinsField("Self-delegation", coinList(m.value)),
        ...text("Commission", pctText(c.rate), true),
      ];
    }

    case "MsgEditValidator": {
      const d = (m.description as Raw | undefined) ?? {};
      return [
        ...addr("Validator", m.validator_address),
        ...text("Moniker", d.moniker && d.moniker !== "[do-not-modify]" ? d.moniker : null),
        ...text("Commission", pctText(m.commission_rate), true),
      ];
    }

    case "MsgUnjail":
      return addr("Validator", m.validator_addr ?? m.validator_address);

    case "MsgSwapExactAmountIn":
    case "MsgSplitRouteSwapExactAmountIn": {
      const routes = ((m.routes as Raw[] | undefined) ?? [])
        .map((r) => str(r.pool_id ?? r.poolId))
        .filter(Boolean)
        .join(" → ");
      const swapped = eventsOf(ctx, "token_swapped");
      const out = swapped.length ? parseCoinString(swapped[swapped.length - 1].attributes.tokens_out) : [];
      return [
        ...addr("Sender", m.sender),
        ...text("Pools", routes || null, true),
        ...coinsField("Token in", coinList(m.token_in)),
        ...coinsField("Token out", out),
        ...text("Minimum out", m.token_out_min_amount, true),
      ];
    }

    default:
      return [];
  }
}

/** IBC memos are often JSON (packet-forward, wasm hooks); show them as JSON. */
function memoField(v: unknown): DecodedField[] {
  const t = str(v);
  if (!t) return [];
  if (/^\s*[{[]/.test(t)) {
    try {
      return [{ label: "Memo", value: { kind: "json", json: prettyJson(JSON.parse(t)) } }];
    } catch {
      /* not JSON after all */
    }
  }
  return text("Memo", t);
}

function timeoutText(m: Raw): string | null {
  const ts = str(m.timeout_timestamp);
  if (ts && ts !== "0") {
    const ms = Number(BigInt(ts) / BigInt(1_000_000));
    if (Number.isFinite(ms)) return new Date(ms).toISOString().replace(".000Z", "Z");
  }
  const h = m.timeout_height as Raw | undefined;
  const height = str(h?.revision_height);
  return height && height !== "0" ? `height ${height}` : null;
}

function pctText(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : null;
}

function ackResult(ack: unknown): string | null {
  const s = str(ack);
  if (!s) return null;
  try {
    const v = JSON.parse(b64utf8(s));
    if (v && typeof v === "object") return "error" in v ? `Error: ${String(v.error)}` : "Success";
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Decode one message. `value` is the message object as the REST API returns it
 * (its "@type" is ignored; `typeUrl` wins). Authz MsgExec keeps its inner
 * messages beneath it rather than flattening them away with the grantee.
 */
export function decodeMessage(
  chainId: string,
  typeUrl: string,
  value: Raw,
  ctx?: DecodeContext,
  depth = 0
): DecodedMessage & { rows: DecodedRow[] } {
  const name = typeName(typeUrl);
  let fields = decodeFields(chainId, name, value, ctx);
  let inner: DecodedMessage[] | undefined;

  if (name === "MsgExec" && Array.isArray(value.msgs) && depth < 4) {
    inner = (value.msgs as Raw[]).map((msg) =>
      decodeMessage(chainId, String(msg["@type"] ?? ""), msg, ctx, depth + 1)
    );
  }

  // Unknown type: show what it is and what it says, rather than nothing.
  if (fields.length === 0 && !inner) {
    const { ["@type"]: _t, ...rest } = value;
    void _t;
    fields = [{ label: "Type", value: { kind: "text", text: typeUrl, mono: true } }, ...jsonField("Message", rest)];
  }

  const decoded: DecodedMessage = { typeUrl, label: labelForType(typeUrl), fields, ...(inner ? { inner } : {}) };
  return { ...decoded, rows: fieldsToRows(decoded.fields, ctx?.formatCoins) };
}

/** Fields as plain rows for PopupRows / BrickBoard detail rows. */
export function fieldsToRows(
  fields: DecodedField[],
  formatCoins?: (coins: Coin[]) => string
): DecodedRow[] {
  return fields.map((f) => {
    const v = f.value;
    switch (v.kind) {
      case "address":
        return { label: f.label, value: v.address, mono: true, address: v.address };
      case "link":
        return { label: f.label, value: v.text, mono: v.mono, href: v.href };
      case "coins":
        return {
          label: f.label,
          value: formatCoins
            ? formatCoins(v.coins)
            : v.coins.map((c) => `${c.amount} ${c.denom}`).join(", "),
          mono: true,
        };
      case "json":
        return { label: f.label, value: v.json, mono: true };
      default:
        return { label: f.label, value: v.text, mono: v.mono };
    }
  });
}
