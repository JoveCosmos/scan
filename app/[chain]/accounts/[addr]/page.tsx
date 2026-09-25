import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getChain, symbolFor, accentFor, chainDenoms } from "@/lib/chains";
import type { ChainConfig } from "@/lib/chains";
import type { DenomInfo } from "@/lib/coin";
import { formatCoin, formatCoins } from "@/lib/coin";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { decodeParam, timeAgo, truncateMiddle } from "@/lib/format";
import { linkedAddresses } from "@/lib/bech32";
import { resolveIbcDenoms, type DenomTrace } from "@/lib/ibc";
import { getAccountStaking } from "@/lib/staking";
import { directionFor, type TxTransfer } from "@/lib/tx-parties";
import { CopyButton } from "@/components/copy-button";
import { LinkedAddresses } from "@/components/linked-addresses";
import { AddressElsewhere } from "@/components/address-elsewhere";
import { LoadingPanel } from "@/components/loading-panel";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck, type DeckColumn, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ addr: string }>;
}): Promise<Metadata> {
  const { addr } = await params;
  return { title: `Account ${decodeParam(addr).slice(0, 12)}…` };
}

/**
 * IBC denoms are opaque hashes until resolved through a denom trace.
 *
 * Natives covers every denom the chain declares, not just the staking one:
 * AtomOne issues PHOTON alongside ATONE, and matching on chain.denom alone left
 * a PHOTON balance labelled "uphoton" and printed unscaled.
 */
function denomLabel(
  denom: string,
  natives: Map<string, DenomInfo>,
  trace?: DenomTrace
): string {
  const native = natives.get(denom);
  if (native) return native.symbol;
  if (trace) return trace.symbol;
  if (denom.startsWith("ibc/")) return `IBC ${denom.slice(4, 10)}…`;
  return denom;
}

/**
 * Exact display amount. The brick above uses compact notation, so the deck
 * deliberately shows the full number — abbreviating both meant a balance of
 * 999.999997B also rendered as "1000.0000B", two values for one figure.
 */
function exactAmount(raw: string, exponent: number): string {
  if (!/^\d+$/.test(raw)) return raw;

  // Balances routinely exceed Number.MAX_SAFE_INTEGER — a 999999997125000000
  // ugnot balance divided as a float rendered as ...124.9999. Split with BigInt.
  // BigInt(...) rather than 10n literals, which need an ES2020 target.
  const value = BigInt(raw);
  const base = BigInt(10) ** BigInt(exponent);
  const whole = (value / base).toLocaleString();
  const fraction = (value % base).toString().padStart(exponent, "0").replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * What a transaction moved, from this account's point of view.
 *
 * Signed rather than arrowed: the page is already about one address, so "−12
 * ATONE" says in one glance what an arrow needs a legend to say. Four decimals
 * would round a dust payment to "0.0000", which is not a small number but a
 * wrong one, so those are named as small instead.
 */
function movedAmount(
  transfer: TxTransfer | null,
  direction: ReturnType<typeof directionFor>,
  denoms: DenomInfo[]
): string {
  if (!transfer || transfer.amount.length === 0) return "—";

  const sign = direction === "out" ? "−" : direction === "in" ? "+" : "";
  const text = transfer.amount
    .map((coin) => {
      const formatted = formatCoin(coin, denoms, 4);
      const dust =
        formatted.startsWith("0.0000") && /^\d+$/.test(coin.amount) && coin.amount !== "0";
      return dust ? formatted.replace("0.0000", "<0.0001") : formatted;
    })
    .join(", ");

  return `${sign}${text}`;
}

/** "in 12 days", for an unbonding or redelegation that has not completed yet. */
function completesIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "any moment";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "in under an hour";
}

/**
 * What an account has at stake, per validator.
 *
 * Three lists on the wire — bonded, unbonding, redelegating — and one deck
 * here. They were three stacked tables, which on a fixed-height page would put
 * the second one below the fold; as one list with a state column they stay
 * comparable, and a delegation carries its dates and addresses in its popup.
 *
 * Read here rather than in a shared component so the rows arrive as plain data:
 * the deck is a client component and the staking module is not.
 */
async function StakingDeck({
  chain,
  address,
  accent,
}: {
  chain: ChainConfig;
  address: string;
  accent: string;
}) {
  const staking = await getAccountStaking(chain, address);
  const symbol = symbolFor(chain);
  const base = `/${chain.chainId}/validators`;
  const amount = (raw: string) => `${formatToken(raw, chain.exponent, 2)} ${symbol}`;

  const columns: DeckColumn[] = [
    { label: "Validator" },
    { label: "State", width: "18%", phoneHide: true },
    { label: "Amount", align: "right", width: "22%" },
    { label: "Reward", align: "right", width: "20%", optional: true },
  ];

  const rows: DeckRow[] = [
    ...staking.delegations.map((d) => ({
      key: `delegation-${d.validator}`,
      cells: [
        { v: d.moniker ?? truncateMiddle(d.validator, 14, 8), tone: "accent" as const },
        {
          v: d.jailed ? "jailed" : "bonded",
          dim: true,
          tone: d.jailed ? ("bad" as const) : undefined,
        },
        { v: amount(d.amount), mono: true, align: "right" as const },
        {
          v: d.reward === null ? "—" : amount(d.reward),
          mono: true,
          dim: true,
          align: "right" as const,
        },
      ],
      detail: {
        title: d.moniker ?? "Delegation",
        sub: d.validator,
        rows: [
          { label: "State", value: d.jailed ? "Bonded, validator jailed" : "Bonded" },
          { label: "Delegated", value: exactAmount(d.amount, chain.exponent), mono: true },
          {
            label: "Reward",
            // Rewards below one base unit are not claimable, so they are
            // truncated upstream rather than rounded into existence.
            value: d.reward === null ? "N/A" : exactAmount(d.reward, chain.exponent),
            mono: true,
          },
          { label: "Validator", value: d.validator, mono: true },
        ],
        action: { label: "Validator", href: `${base}/${d.validator}` },
      },
    })),
    ...staking.unbonding.map((u, i) => ({
      key: `unbonding-${u.validator}-${u.completion}-${i}`,
      cells: [
        { v: u.moniker ?? truncateMiddle(u.validator, 14, 8), tone: "accent" as const },
        { v: "unbonding", dim: true },
        { v: amount(u.amount), mono: true, align: "right" as const },
        { v: completesIn(u.completion), dim: true, align: "right" as const },
      ],
      detail: {
        title: u.moniker ?? "Unbonding",
        sub: u.validator,
        rows: [
          { label: "State", value: "Unbonding" },
          { label: "Amount", value: exactAmount(u.amount, chain.exponent), mono: true },
          { label: "Liquid", value: `${completesIn(u.completion)} — ${u.completion}` },
          { label: "Validator", value: u.validator, mono: true },
        ],
        action: { label: "Validator", href: `${base}/${u.validator}` },
      },
    })),
    ...staking.redelegations.map((r, i) => ({
      key: `redelegation-${r.from}-${r.to}-${r.completion}-${i}`,
      cells: [
        {
          v: `${r.fromMoniker ?? truncateMiddle(r.from, 8, 6)} → ${
            r.toMoniker ?? truncateMiddle(r.to, 8, 6)
          }`,
          tone: "accent" as const,
        },
        { v: "redelegating", dim: true },
        { v: amount(r.amount), mono: true, align: "right" as const },
        { v: completesIn(r.completion), dim: true, align: "right" as const },
      ],
      detail: {
        title: "Redelegating",
        sub: `${r.fromMoniker ?? r.from} → ${r.toMoniker ?? r.to}`,
        rows: [
          { label: "Amount", value: exactAmount(r.amount, chain.exponent), mono: true },
          { label: "Completes", value: `${completesIn(r.completion)} — ${r.completion}` },
          { label: "From", value: r.from, mono: true },
          { label: "To", value: r.to, mono: true },
        ],
        action: { label: "Destination validator", href: `${base}/${r.to}` },
      },
    })),
  ];

  return (
    <RowDeck
      columns={columns}
      rows={rows}
      accent={accent}
      empty={
        staking.failed
          ? // Never report an empty stake when the module simply did not answer.
            "N/A"
          : "This account has nothing staked."
      }
    />
  );
}

/**
 * Transactions this address sent or received.
 *
 * Streamed on its own because on Cosmos it costs two indexed tx searches, and
 * the bricks above do not wait on it.
 */
async function TransactionDeck({
  chain,
  address,
  accent,
}: {
  chain: ChainConfig;
  address: string;
  accent: string;
}) {
  const { txs, total, failed, source, since, more, fromGenesis } =
    await getAdapter(chain).getAccountTxs(address);
  const denoms = chainDenoms(chain);

  const columns: DeckColumn[] = [
    { label: "Hash", width: "16%" },
    { label: "Type" },
    { label: "Counterparty", optional: true },
    { label: "Amount", align: "right", width: "18%" },
    { label: "Status", width: "11%", phoneHide: true },
    { label: "Height", align: "right", width: "12%", optional: true },
    { label: "Fee", align: "right", width: "12%", optional: true },
    { label: "Age", align: "right", width: "12%", phoneHide: true },
  ];

  const rows: DeckRow[] = txs.map((tx) => {
    const direction = directionFor(tx.transfer, address);
    const other =
      direction === "out" ? tx.transfer?.to : direction === "in" ? tx.transfer?.from : null;
    // Spelled out rather than arrowed: the page is about one address already,
    // so "to osmo1…" reads without a key, and an account that is not a party —
    // a vote, a grant — gets a dash rather than an invented counterparty.
    const counterparty =
      direction === "self"
        ? "self"
        : other
          ? `${direction === "out" ? "to" : "from"} ${truncateMiddle(other, 10, 6)}`
          : "—";
    const status =
      tx.code === null ? "unindexed" : tx.code === 0 ? "success" : `failed ${tx.code}`;
    const label = tx.messages[0]?.label ?? "—";

    return {
      key: tx.hash,
      cells: [
        { v: truncateMiddle(tx.hash, 8, 6), mono: true, tone: "accent" as const },
        { v: tx.messages.length > 1 ? `${label} +${tx.messages.length - 1}` : label },
        { v: counterparty, dim: true },
        {
          v: movedAmount(tx.transfer, direction, denoms),
          mono: true,
          align: "right" as const,
          tone: direction === "out" ? ("bad" as const) : direction === "in" ? ("ok" as const) : undefined,
        },
        {
          v: status,
          dim: tx.code === null,
          tone: tx.code === null ? undefined : tx.code === 0 ? ("ok" as const) : ("bad" as const),
        },
        {
          v: Number(tx.height).toLocaleString(),
          mono: true,
          dim: true,
          align: "right" as const,
        },
        {
          v: formatCoins(tx.fee, denoms),
          mono: true,
          dim: true,
          align: "right" as const,
        },
        { v: timeAgo(tx.time), dim: true, align: "right" as const },
      ],
      detail: {
        title: label,
        sub: tx.hash,
        rows: [
          { label: "Hash", value: tx.hash, mono: true },
          {
            label: "Messages",
            value: tx.messages.map((m) => m.label).join(", ") || String(tx.messageCount),
          },
          {
            label: "Counterparty",
            value:
              direction === "self" ? address : (other ?? "Not a party to this transaction"),
            mono: direction === "self" || other !== null,
          },
          { label: "Amount", value: movedAmount(tx.transfer, direction, denoms), mono: true },
          { label: "Fee", value: formatCoins(tx.fee, denoms), mono: true },
          { label: "Status", value: status },
          { label: "Height", value: Number(tx.height).toLocaleString(), mono: true },
          { label: "When", value: `${timeAgo(tx.time)} — ${tx.time ?? "unknown"}` },
        ],
        action: {
          label: "Full transaction",
          href: `/${chain.chainId}/txs/${encodeURIComponent(tx.hash)}`,
        },
      },
    };
  });

  // The window is stated only while there is one. A list that stops at the edge
  // of a partial index reads as the account's whole history and has to say
  // otherwise — but once the backfill reaches genesis it *is* the whole
  // history, and naming the chain's start date implies a limit that no longer
  // exists.
  const provenance =
    txs.length === 0
      ? null
      : source === "indexer"
        ? `${more ? `Showing the ${txs.length} most recent. ` : ""}${
            fromGenesis
              ? "From our index of the chain's full history."
              : `From our index of block history, covering ${new Date(
                  since ?? ""
                ).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })} onwards.`
          }`
        : total !== null && total > txs.length
          ? `Showing the ${txs.length} most recent of ${total.toLocaleString()}.`
          : null;

  return (
    <RowDeck
      columns={columns}
      rows={rows}
      accent={accent}
      toolbar={
        provenance ? (
          <p className="text-[11px] text-muted-foreground">{provenance}</p>
        ) : undefined
      }
      empty={
        failed
          ? "N/A"
          : "No transactions found for this address."
      }
    />
  );
}

/**
 * One account, in one screen.
 *
 * The three headline figures are bricks and the three lists take turns, because
 * stacked they ran to four screens: balances, then delegations, then unbonding,
 * then a transaction table nobody scrolled to. Nothing is gone — the address,
 * account number and sequence that filled a panel of their own are behind the
 * Account brick, and each row carries its full record in a popup.
 */
export default async function AccountPage({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}) {
  const { chain: chainId, addr: rawAddr } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const address = decodeParam(rawAddr);
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);
  const account = await getAdapter(chain).getAccount(address);
  // Same key, different prefix — offered so one account can be followed across
  // chains without deriving the address by hand.
  const links = linkedAddresses(address);
  // Every denom the chain issues, keyed for lookup — not just the staking one.
  const natives = new Map(chainDenoms(chain).map((d) => [d.denom, d]));
  // Turns "IBC 3EF74C…" into the asset it actually is.
  const traces = await resolveIbcDenoms(
    chain,
    account.balances.map((b) => b.denom)
  );

  const primary = account.balances.find((b) => b.denom === chain.denom);
  const others = account.balances.filter((b) => b.denom !== chain.denom);

  const facts: BrickSpec[] = [
    {
      key: "available",
      label: "Available",
      value: primary ? formatToken(primary.amount, chain.exponent, 2) : "0",
      sub: symbol,
      lead: true,
      rows: primary
        ? [
            {
              label: "Available",
              value: `${exactAmount(primary.amount, chain.exponent)} ${symbol}`,
              mono: true,
            },
            { label: "Base denom", value: chain.denom, mono: true },
            { label: "Base units", value: primary.amount, mono: true },
          ]
        : undefined,
    },
    {
      key: "delegated",
      label: "Delegated",
      value: account.delegatedTotal
        ? formatToken(account.delegatedTotal, chain.exponent, 2)
        : "—",
      sub:
        account.delegationCount != null
          ? `${account.delegationCount} validator${account.delegationCount === 1 ? "" : "s"}`
          : "not applicable",
      rows: account.delegatedTotal
        ? [
            {
              label: "Delegated",
              value: `${exactAmount(account.delegatedTotal, chain.exponent)} ${symbol}`,
              mono: true,
            },
            {
              label: "Validators",
              value: String(account.delegationCount ?? "—"),
              mono: true,
            },
          ]
        : undefined,
    },
    {
      key: "others",
      label: "Other assets",
      value: String(others.length),
      sub: "denominations",
      rows:
        others.length > 0
          ? others.map((b) => ({
              label: denomLabel(b.denom, natives, traces.get(b.denom)),
              value: natives.has(b.denom)
                ? exactAmount(b.amount, natives.get(b.denom)!.exponent)
                : Number(b.amount).toLocaleString(),
              mono: true,
            }))
          : undefined,
    },
    {
      key: "account",
      label: "Account",
      value: account.accountNumber ?? "—",
      sub: `sequence ${account.sequence ?? "—"}`,
      rows: [
        { label: "Address", value: address, mono: true },
        { label: "Account number", value: account.accountNumber ?? "—", mono: true },
        { label: "Sequence", value: account.sequence ?? "—", mono: true },
      ],
    },
  ];

  const balanceColumns: DeckColumn[] = [
    { label: "Asset" },
    { label: "Route", optional: true },
    { label: "Amount", align: "right", width: "40%" },
  ];

  const balanceRows: DeckRow[] = account.balances.map((b) => {
    const trace = traces.get(b.denom);
    const native = natives.get(b.denom);
    const exact = native
      ? exactAmount(b.amount, native.exponent)
      : Number(b.amount).toLocaleString();

    return {
      key: b.denom,
      cells: [
        { v: denomLabel(b.denom, natives, trace), tone: "accent" as const },
        { v: trace?.channels.length ? `via ${trace.channels.join(" → ")}` : "—", dim: true },
        { v: exact, mono: true, align: "right" as const },
      ],
      detail: {
        title: denomLabel(b.denom, natives, trace),
        sub: b.denom,
        rows: [
          { label: "Amount", value: exact, mono: true },
          { label: "Base units", value: b.amount, mono: true },
          { label: "Denom", value: b.denom, mono: true },
          ...(native ? [{ label: "Exponent", value: String(native.exponent), mono: true }] : []),
          // An IBC hash says nothing about what it holds; the trace is the only
          // place the asset names itself.
          ...(trace ? [{ label: "Home denom", value: trace.base, mono: true }] : []),
          ...(trace?.channels.length
            ? [{ label: "Channels", value: trace.channels.join(" → "), mono: true }]
            : []),
        ],
      },
    };
  });

  const sections = [
    ...(account.balances.length > 0
      ? [
          {
            key: "balances",
            label: `Balances (${account.balances.length})`,
            content: (
              <RowDeck columns={balanceColumns} rows={balanceRows} accent={accent} />
            ),
          },
        ]
      : []),
    // Skipped where the chain has no staking module at all — gno.land has no
    // validators to delegate to, so an empty "nothing staked" tab there would
    // offer a feature that does not exist.
    ...(getAdapter(chain).capabilities.staking
      ? [
          {
            key: "staking",
            label: "Staking",
            content: (
              <Suspense fallback={<LoadingPanel label="Loading delegations…" rows={3} />}>
                <StakingDeck chain={chain} address={address} accent={accent} />
              </Suspense>
            ),
          },
        ]
      : []),
    {
      key: "txs",
      label: "Transactions",
      content: (
        <Suspense fallback={<LoadingPanel label="Loading transactions…" rows={4} />}>
          <TransactionDeck chain={chain} address={address} accent={accent} />
        </Suspense>
      ),
    },
  ];

  return (
    <PageFrame
      title="Account"
      sub={address}
      accent={accent}
      actions={
        <>
          <CopyButton value={address} label="address" />
          <LinkedAddresses links={links} currentChainId={chainId} />
        </>
      }
    >
      <div className="flex h-full flex-col gap-3">
        {account.exists ? (
          <BrickBoard bricks={facts} accent={accent} className="shrink-0" />
        ) : (
          // An unused address keeps the tabs below: the transaction list is
          // read from block history, not from account state, and an address
          // with a spent balance still has one.
          <div className="min-h-0 shrink-0 overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              No on-chain activity.
            </p>
            {/* Streamed: checks the same key on every linked chain. */}
            <Suspense fallback={null}>
              <AddressElsewhere links={links} currentChainId={chainId} />
            </Suspense>
          </div>
        )}

        <div className="min-h-0 flex-1">
          <SectionTabs sections={sections} />
        </div>
      </div>
    </PageFrame>
  );
}
