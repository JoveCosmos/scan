import type { ChainConfig } from "@/lib/chains";
import { chainDenoms } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { shortDenom } from "@/lib/coin";
import { timeAgo, truncateMiddle } from "@/lib/format";
import type { DeckColumn, DeckRow } from "@/components/row-deck";

/**
 * Deck rows for the validator page's paged lists (proposed blocks, power
 * events). Built on the server both for the first page and for each "Older"
 * page the routes beside this file serve, so the two can never differ.
 */

export const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The chain's own denoms scaled and named; anything else (an IBC hash) as-is. */
export function coinFormatter(chain: ChainConfig) {
  const known = new Map(chainDenoms(chain).map((d) => [d.denom, d]));
  const coin = (c: { denom: string; amount: string }, frac = 2) => {
    const info = known.get(c.denom);
    return info
      ? `${formatToken(c.amount, info.exponent, frac)} ${info.symbol}`
      : `${c.amount} ${shortDenom(c.denom)}`;
  };
  return { coin, symbolOf: (denom: string) => known.get(denom)?.symbol ?? shortDenom(denom) };
}

export const PROPOSED_COLUMNS: DeckColumn[] = [
  { label: "Block" },
  { label: "Age", align: "right", width: "30%" },
  { label: "Txs", align: "right", width: "18%" },
];

export function proposedRows(
  chainId: string,
  blocks: { height: number; time: string; txCount: number }[]
): DeckRow[] {
  return blocks.map((b) => ({
    key: String(b.height),
    cells: [
      { v: `#${b.height.toLocaleString()}`, mono: true, tone: "accent" },
      { v: timeAgo(b.time), dim: true, align: "right" },
      { v: String(b.txCount), mono: true, align: "right" },
    ],
    detail: {
      title: `Block ${b.height}`,
      rows: [],
      action: { label: "Block", href: `/${chainId}/blocks/${b.height}` },
    },
  }));
}

/** Stake moving in and out, signed from this validator's side. */
export function powerKind(e: { kind: string; validatorDst: string | null }, addr: string) {
  switch (e.kind) {
    case "delegate":
      return { label: "Delegate", sign: 1 };
    case "undelegate":
      return { label: "Undelegate", sign: -1 };
    case "redelegate":
      return e.validatorDst === addr
        ? { label: "Redelegate in", sign: 1 }
        : { label: "Redelegate out", sign: -1 };
    case "cancel_unbonding":
      return { label: "Cancel unbonding", sign: 1 };
    case "create_validator":
      return { label: "Create", sign: 1 };
    case "edit_validator":
      return { label: "Edit", sign: 0 };
    default:
      return { label: e.kind, sign: 0 };
  }
}

export const POWER_COLUMNS: DeckColumn[] = [
  { label: "Event", width: "18%" },
  { label: "Delegator", phoneHide: true },
  { label: "Amount", align: "right", width: "22%" },
  { label: "Block", align: "right", width: "15%", optional: true },
  { label: "Date", align: "right", width: "16%" },
];

export function powerRows(
  chain: ChainConfig,
  addr: string,
  events: {
    height: number;
    txHash: string;
    time: string;
    kind: string;
    validatorDst: string | null;
    delegator: string | null;
    amount: string | null;
  }[]
): DeckRow[] {
  const chainId = chain.chainId;
  const { coin } = coinFormatter(chain);
  const signed = (amount: string | null, sign: number) =>
    !amount || sign === 0 ? "-" : `${sign > 0 ? "+" : "−"}${coin({ denom: chain.denom, amount })}`;
  return events.map((e) => {
    const k = powerKind(e, addr);
    return {
      key: `${e.txHash}-${e.height}-${e.kind}-${e.delegator ?? ""}`,
      cells: [
        { v: k.label, tone: k.sign > 0 ? "ok" : k.sign < 0 ? "bad" : undefined },
        e.delegator
          ? { v: truncateMiddle(e.delegator, 10, 6), address: e.delegator, mono: true }
          : { v: "-", dim: true },
        { v: signed(e.amount, k.sign), mono: true, align: "right", dim: k.sign === 0 },
        { v: `#${e.height.toLocaleString()}`, mono: true, align: "right", href: `/${chainId}/blocks/${e.height}` },
        { v: day(e.time), dim: true, align: "right" },
      ],
      detail: {
        title: k.label,
        rows: [],
        action: e.txHash
          ? { label: "Transaction", href: `/${chainId}/txs/${e.txHash}` }
          : { label: "Block", href: `/${chainId}/blocks/${e.height}` },
      },
    };
  });
}
