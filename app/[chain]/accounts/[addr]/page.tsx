import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { getAllChains, getChain, symbolFor, accentFor, chainDenoms } from "@/lib/chains";
import type { ChainConfig } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import {
  decodeParam,
  formatDate,
  formatDateTime,
  formatUnits,
  timeAgo,
  timeUntil,
  truncateMiddle,
} from "@/lib/format";
import { convertAddress, linkedAddresses } from "@/lib/bech32";
import { withinBudget } from "@/lib/cache";
import { getGovernors, governorOf } from "@/lib/governors";
import { decodeBech32, gnoPathHref, routeAddress } from "@/lib/address-route";
import { isUserKey, type AddressKind } from "@/lib/address-kind";
import { resolveAssets, type AssetInfo } from "@/lib/ibc";
import { getAccountStaking, getSelfBond, type ValidatorState } from "@/lib/staking";
import { findValidator, type ValidatorSummary } from "@/lib/validators";
import { consensusIdsFromPubkey } from "@/lib/uptime";
import { fetchLcd } from "@/lib/lcd";
import { getValoperIndexNow } from "@/lib/gno-valopers";
import type { AccountView, Coin } from "@/lib/accounts";
import { CopyButton } from "@/components/copy-button";
import { LinkedAddresses } from "@/components/linked-addresses";
import { AddressElsewhere } from "@/components/address-elsewhere";
import { LoadingPanel } from "@/components/loading-panel";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck, type DeckColumn, type DeckRow } from "@/components/row-deck";
import { coverageOf, indexerHealth } from "@/lib/indexer-coverage";
import {
  addressTxCount,
  packetStatus,
  packetsForAddress,
  stakingHistory,
  type PacketRow,
  type StakingEventRow,
} from "@/lib/indexer-tx";
import { counterpartyChainOf } from "@/lib/txs";
import { formatCoin } from "@/lib/coin";
import { getInactiveValidators, getValidatorsCached } from "@/lib/validators";
import { AccountHistory } from "./history";
import { buildHistoryRows } from "./history-rows";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ addr: string }>;
}): Promise<Metadata> {
  const { addr } = await params;
  return { title: `Account ${decodeParam(addr).slice(0, 12)}…` };
}

const prefixes = () =>
  getAllChains().map((c) => ({
    chainId: c.chainId,
    bech32Prefix: c.bech32Prefix,
    network: c.network,
  }));

/** Where a validator stands, in one word. */
const STATE_LABEL: Record<Exclude<ValidatorState, null>, string> = {
  active: "active",
  jailed: "jailed",
  inactive: "inactive",
  unbonding: "unbonding",
};

/** "12 Oct 2026 · in 11d 4h" for a completion time. */
function completes(iso: string): string {
  const until = timeUntil(iso);
  return until && until !== "ended" ? `${formatDate(iso)}, ${until}` : formatDate(iso);
}

/**
 * What an account has at stake, per validator: bonded, unbonding and
 * redelegating in one list with a state column. Every validator is a real
 * link, the source of a redelegation included.
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
  const name = (valoper: string, moniker: string | null) =>
    moniker ?? truncateMiddle(valoper, 14, 8);

  const columns: DeckColumn[] = [
    { label: "Validator" },
    { label: "State", width: "22%", phoneHide: true },
    { label: "Amount", align: "right", width: "20%" },
    { label: "Reward / completes", align: "right", width: "24%" },
  ];

  const rows: DeckRow[] = [
    ...staking.delegations.map((d) => ({
      key: `delegation-${d.validator}`,
      cells: [
        {
          v: name(d.validator, d.moniker),
          tone: "accent" as const,
          href: `${base}/${d.validator}`,
        },
        {
          v: d.state ? STATE_LABEL[d.state] : "delegated",
          dim: d.state !== "jailed",
          tone: d.state === "jailed" ? ("bad" as const) : undefined,
        },
        { v: amount(d.amount), mono: true, align: "right" as const },
        {
          v: d.reward === null ? "N/A" : amount(d.reward),
          mono: true,
          dim: true,
          align: "right" as const,
        },
      ],
      detail: {
        title: name(d.validator, d.moniker),
        rows: [
          { label: "Delegated", value: formatUnits(d.amount, chain.exponent), mono: true },
          { label: "Validator", value: d.validator, mono: true, address: d.validator },
        ],
        action: { label: "Validator", href: `${base}/${d.validator}` },
      },
    })),
    ...staking.unbonding.map((u, i) => ({
      key: `unbonding-${u.validator}-${u.completion}-${i}`,
      cells: [
        {
          v: name(u.validator, u.moniker),
          tone: "accent" as const,
          href: `${base}/${u.validator}`,
        },
        { v: "unbonding", dim: true },
        { v: amount(u.amount), mono: true, align: "right" as const },
        { v: completes(u.completion), dim: true, align: "right" as const },
      ],
      detail: {
        title: name(u.validator, u.moniker),
        rows: [
          { label: "Amount", value: formatUnits(u.amount, chain.exponent), mono: true },
          { label: "Completes", value: formatDateTime(u.completion) },
          { label: "Validator", value: u.validator, mono: true, address: u.validator },
        ],
        action: { label: "Validator", href: `${base}/${u.validator}` },
      },
    })),
    ...staking.redelegations.map((r, i) => ({
      key: `redelegation-${r.from}-${r.to}-${r.completion}-${i}`,
      cells: [
        { v: name(r.to, r.toMoniker), tone: "accent" as const, href: `${base}/${r.to}` },
        { v: `from ${name(r.from, r.fromMoniker)}`, dim: true, href: `${base}/${r.from}` },
        { v: amount(r.amount), mono: true, align: "right" as const },
        { v: completes(r.completion), dim: true, align: "right" as const },
      ],
      detail: {
        title: "Redelegating",
        rows: [
          { label: "Amount", value: formatUnits(r.amount, chain.exponent), mono: true },
          { label: "Completes", value: formatDateTime(r.completion) },
          { label: "From", value: r.from, mono: true, address: r.from },
          { label: "To", value: r.to, mono: true, address: r.to },
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
      empty={staking.failed ? "N/A" : "Nothing staked"}
    />
  );
}

const HISTORY_COLUMNS: DeckColumn[] = [
  { label: "Hash", width: "16%" },
  { label: "Type" },
  { label: "Counterparty", optional: true },
  { label: "Amount", align: "right", width: "18%" },
  { label: "Status", width: "11%", phoneHide: true },
  { label: "Height", align: "right", width: "12%", optional: true },
  { label: "Fee", align: "right", width: "12%", optional: true },
  { label: "Age", align: "right", width: "12%", phoneHide: true },
];

const STAKING_KIND: Record<string, string> = {
  delegate: "Delegate",
  undelegate: "Undelegate",
  redelegate: "Redelegate",
  cancel_unbonding: "Cancel unbonding",
  create_validator: "Create validator",
  edit_validator: "Edit validator",
  complete_unbonding: "Unbonding completed",
  complete_redelegation: "Redelegation completed",
};

/** Monikers for operator addresses, from the cached active and inactive sets. */
async function monikers(chain: ChainConfig): Promise<Map<string, string>> {
  const [active, inactive] = await Promise.all([
    getValidatorsCached(chain).catch(() => []),
    getInactiveValidators(chain).catch(() => []),
  ]);
  return new Map([...active, ...inactive].map((v) => [v.operatorAddress, v.moniker]));
}

/** Every delegation, undelegation and redelegation this address made, from the index. */
async function StakingHistoryDeck({
  chain,
  address,
  accent,
}: {
  chain: ChainConfig;
  address: string;
  accent: string;
}) {
  const [events, names] = await Promise.all([
    stakingHistory(chain.chainId, address),
    monikers(chain),
  ]);
  const denoms = chainDenoms(chain);
  const vname = (v: string | null) => (v ? (names.get(v) ?? truncateMiddle(v, 14, 6)) : "-");

  const columns: DeckColumn[] = [
    { label: "Event", width: "18%" },
    { label: "Validator" },
    { label: "Amount", align: "right", width: "18%" },
    { label: "Completes", align: "right", width: "18%", optional: true },
    { label: "Height", align: "right", width: "12%", phoneHide: true },
    { label: "Age", align: "right", width: "10%", phoneHide: true },
  ];

  const rows: DeckRow[] = (events ?? []).map((e: StakingEventRow, i) => ({
    key: `${e.height}-${e.txHash}-${i}`,
    cells: [
      { v: STAKING_KIND[e.kind] ?? e.kind },
      e.validator
        ? {
            v:
              e.kind === "redelegate" && e.validatorDst
                ? `${vname(e.validator)} → ${vname(e.validatorDst)}`
                : vname(e.validator),
            address: e.kind === "redelegate" && e.validatorDst ? e.validatorDst : e.validator,
          }
        : { v: "-", dim: true },
      {
        v: e.amount && e.denom ? formatCoin({ denom: e.denom, amount: e.amount }, denoms, 4) : "-",
        mono: true,
        align: "right" as const,
        tone:
          e.kind === "delegate" ? ("ok" as const) : e.kind === "undelegate" ? ("bad" as const) : undefined,
      },
      {
        v: e.completionTime ? completes(e.completionTime) : "-",
        dim: true,
        align: "right" as const,
      },
      {
        v: Number(e.height).toLocaleString(),
        mono: true,
        dim: true,
        align: "right" as const,
        href: `/${chain.chainId}/blocks/${e.height}`,
      },
      { v: timeAgo(e.time), dim: true, align: "right" as const },
    ],
    detail: {
      title: STAKING_KIND[e.kind] ?? e.kind,
      rows: [
        ...(e.validator ? [{ label: "Validator", value: e.validator, mono: true, address: e.validator }] : []),
        ...(e.validatorDst
          ? [{ label: "To validator", value: e.validatorDst, mono: true, address: e.validatorDst }]
          : []),
      ],
      ...(e.txHash
        ? {
            action: {
              label: "Transaction",
              href: `/${chain.chainId}/txs/${encodeURIComponent(e.txHash)}`,
            },
          }
        : {}),
    },
  }));

  return (
    <RowDeck columns={columns} rows={rows} accent={accent} empty={events ? "No staking events" : "N/A"} />
  );
}

const PACKET_STATUS: Record<ReturnType<typeof packetStatus>, string> = {
  acked: "acked",
  error: "ack error",
  timeout: "timed out",
  received: "received",
  pending: "pending",
};

/** This address's IBC transfers, sent and received, from the index. */
async function IbcDeck({
  chain,
  address,
  accent,
}: {
  chain: ChainConfig;
  address: string;
  accent: string;
}) {
  const packets = await packetsForAddress(chain.chainId, address);
  const denoms = chainDenoms(chain);
  const carried = getAllChains();

  // The chain on the far side of each local channel, looked up once per channel.
  const local = (p: PacketRow) =>
    p.direction === "out"
      ? { port: p.srcPort, channel: p.srcChannel }
      : { port: p.dstPort ?? "transfer", channel: p.dstChannel ?? "" };
  const channels = [...new Set((packets ?? []).map((p) => `${local(p).port}|${local(p).channel}`))];
  const cpByChannel = new Map(
    await Promise.all(
      channels.map(async (key) => {
        const [port, channel] = key.split("|");
        const id = channel ? await counterpartyChainOf(chain, port, channel).catch(() => null) : null;
        return [key, id] as const;
      })
    )
  );

  const columns: DeckColumn[] = [
    { label: "Direction", width: "12%" },
    { label: "Other chain" },
    { label: "Amount", align: "right", width: "20%" },
    { label: "Status", width: "12%", phoneHide: true },
    { label: "Channel", width: "12%", optional: true },
    { label: "Age", align: "right", width: "10%", phoneHide: true },
  ];

  const rows: DeckRow[] = (packets ?? []).map((p) => {
    const l = local(p);
    const cpId = cpByChannel.get(`${l.port}|${l.channel}`) ?? null;
    const cp = cpId ? carried.find((c) => c.chainId === cpId) : undefined;
    const other = p.direction === "out" ? p.receiver : p.sender;
    const status = packetStatus(p);
    const txHash = p.direction === "out" ? p.sendTx : p.recvTx;
    const time = p.direction === "out" ? p.sendTime : p.recvTime;
    return {
      key: `${p.direction}-${p.srcChannel}-${p.sequence}`,
      cells: [
        {
          v: p.direction === "out" ? "sent" : "received",
          tone: p.direction === "out" ? ("bad" as const) : ("ok" as const),
        },
        other
          ? { v: `${cp?.prettyName ?? cpId ?? "-"}, ${truncateMiddle(other, 10, 6)}`, address: other }
          : { v: cp?.prettyName ?? cpId ?? "-", dim: !cp },
        {
          v: p.amount && p.denom ? formatCoin({ denom: p.denom, amount: p.amount }, denoms, 4) : "-",
          mono: true,
          align: "right" as const,
        },
        {
          v: PACKET_STATUS[status],
          tone:
            status === "error" || status === "timeout"
              ? ("bad" as const)
              : status === "acked" || status === "received"
                ? ("ok" as const)
                : undefined,
          dim: status === "pending",
        },
        { v: l.channel || "-", mono: true, dim: true },
        { v: time ? timeAgo(time) : "-", dim: true, align: "right" as const },
      ],
      detail: {
        title: `Packet ${p.sequence}`,
        rows: [
          { label: "Sender", value: p.sender ?? "-", mono: true, ...(p.sender ? { address: p.sender } : {}) },
          {
            label: "Receiver",
            value: p.receiver ?? "-",
            mono: true,
            ...(p.receiver ? { address: p.receiver } : {}),
          },
          ...(p.ackError ? [{ label: "Ack error", value: p.ackError, mono: true }] : []),
        ],
        ...(txHash
          ? {
              action: {
                label: "Transaction",
                href: `/${chain.chainId}/txs/${encodeURIComponent(txHash)}`,
              },
            }
          : {}),
      },
    };
  });

  return <RowDeck columns={columns} rows={rows} accent={accent} empty={packets ? "No IBC transfers" : "N/A"} />;
}

const ROLE_COLUMN: DeckColumn = { label: "Role", width: "12%", phoneHide: true };

/**
 * Transactions this address sent or received, newest first, with an "Older"
 * control. Streamed on its own so the tiles above do not wait on tx search.
 */
async function TransactionDeck({
  chain,
  address,
  accent,
  kind,
  sequence,
}: {
  chain: ChainConfig;
  address: string;
  accent: string;
  kind: AddressKind["kind"] | null;
  sequence: string | null;
}) {
  const res = await getAdapter(chain).getAccountTxs(address, { kind: kind ?? undefined });
  const withRoles = res.txs.some((t) => t.roles && t.roles.length > 0);
  const rows = buildHistoryRows(chain, address, res.txs, withRoles);
  const columns = withRoles
    ? [...HISTORY_COLUMNS.slice(0, 2), ROLE_COLUMN, ...HISTORY_COLUMNS.slice(2)]
    : HISTORY_COLUMNS;

  const facts: string[] = [];
  if (res.source === "indexer") {
    const health = await indexerHealth(chain.chainId);
    if (health?.stale) facts.push("Index behind");
    else if (health?.lag != null && health.lag > 50) facts.push(`${health.lag.toLocaleString()} blocks behind`);
  }
  if (res.source === "indexer" && !res.fromGenesis && res.since) {
    facts.push(`Indexed since ${formatDate(res.since)}`);
  }
  if (res.source === "search" && res.total !== null && res.total > res.txs.length) {
    facts.push(`of ≥${res.total.toLocaleString()}`);
  }
  // Every signed transaction bumps the sequence, so a sequence above what the
  // search found, with nothing older to fetch, means the node's index is cut.
  const signed = Number(sequence ?? 0);
  const partial =
    !res.failed &&
    (res.partial || (!res.next && res.source === "search" && signed > res.txs.length));
  if (partial) facts.push("Partial");

  return (
    <AccountHistory
      chainId={chain.chainId}
      address={address}
      kind={kind}
      withRoles={withRoles}
      columns={columns}
      initialRows={rows}
      initialNext={res.next ?? null}
      facts={facts}
      accent={accent}
      empty={res.failed || (signed > 0 && rows.length === 0) ? "N/A" : "No transactions"}
    />
  );
}

/** Natives first in config order, then IBC, factory, other, CW20; then name. */
function assetOrder(natives: string[]) {
  const rank: Record<AssetInfo["kind"], number> = {
    native: 0,
    ibc: 1,
    factory: 2,
    other: 3,
    cw20: 4,
  };
  return (a: { coin: Coin; asset: AssetInfo }, b: { coin: Coin; asset: AssetInfo }) => {
    const r = rank[a.asset.kind] - rank[b.asset.kind];
    if (r !== 0) return r;
    if (a.asset.kind === "native") {
      return natives.indexOf(a.coin.denom) - natives.indexOf(b.coin.denom);
    }
    return a.asset.symbol.localeCompare(b.asset.symbol);
  };
}

function routeLabel(asset: AssetInfo): string {
  if (asset.kind === "native") return "native";
  if (asset.kind === "ibc") {
    return asset.channels.length ? `via ${asset.channels.join(" → ")}` : "ibc";
  }
  return asset.kind;
}

/** A validator this account operates, for the Validator tile. */
interface OperatedValidator {
  href: string;
  moniker: string;
  status: string;
  commissionRate: number | null;
  outstanding: Coin[] | null;
  selfBond: string | null;
}

async function operatedValidator(
  chain: ChainConfig,
  address: string
): Promise<OperatedValidator | null> {
  if (chain.kind === "gno") {
    const index = await getValoperIndexNow(chain).catch(() => null);
    const profile = index?.byOperator.get(address);
    if (!profile) return null;
    return {
      href: `/${chain.chainId}/validators/${address}`,
      moniker: profile.moniker ?? truncateMiddle(address, 10, 6),
      status: "registered",
      commissionRate: null,
      outstanding: null,
      selfBond: null,
    };
  }

  const valoper = convertAddress(address, `${chain.bech32Prefix}valoper`);
  if (!valoper) return null;
  const v: ValidatorSummary | null = await findValidator(
    chain,
    { operator: valoper },
    () => null
  ).catch(() => null);
  if (!v) return null;

  const [commission, bond] = await Promise.allSettled([
    fetchLcd<{ commission?: { commission?: Coin[] } }>(
      chain,
      `/cosmos/distribution/v1beta1/validators/${valoper}/commission`,
      { cache: "no-store", timeoutMs: 6000, deadlineMs: 9000 }
    ),
    getSelfBond(chain, valoper, v.tokens),
  ]);

  return {
    href: `/${chain.chainId}/validators/${valoper}`,
    moniker: v.moniker,
    status: v.jailed
      ? "jailed"
      : v.status === "BOND_STATUS_BONDED"
        ? "active"
        : v.status === "BOND_STATUS_UNBONDING"
          ? "unbonding"
          : "inactive",
    commissionRate: v.commissionRate,
    outstanding:
      commission.status === "fulfilled"
        ? (commission.value.commission?.commission ?? [])
            .map((c) => ({ denom: c.denom, amount: c.amount.split(".")[0] }))
            .filter((c) => /^\d+$/.test(c.amount) && c.amount !== "0")
        : null,
    selfBond: bond.status === "fulfilled" && bond.value ? bond.value.amount : null,
  };
}

/** The tile that says what an address is when it is not a plain account. */
function kindTile(kind: AddressKind | null, chainId: string): BrickSpec | null {
  if (!kind || kind.kind === "user") return null;
  switch (kind.kind) {
    case "module":
      return {
        key: "kind",
        label: "Module",
        value: kind.name,
        sub: kind.permissions.join(", ") || "module account",
        lead: true,
      };
    case "escrow":
      return {
        key: "kind",
        label: "IBC escrow",
        value: kind.channel,
        sub: "transfer",
        lead: true,
        href: `/${chainId}/relayers`,
      };
    case "ica":
      return {
        key: "kind",
        label: "Interchain account",
        value: kind.owner ? truncateMiddle(kind.owner, 10, 6) : "N/A",
        sub: "owner",
        rows: kind.owner
          ? [{ label: "Owner", value: kind.owner, mono: true, address: kind.owner }]
          : undefined,
      };
    case "contract":
      return {
        key: "kind",
        label: kind.cw20 ? "CW20 contract" : "Contract",
        value:
          kind.cw20?.symbol ?? kind.label ?? (kind.codeId ? `code ${kind.codeId}` : "contract"),
        sub: kind.codeId ? `code ${kind.codeId}` : "cosmwasm",
        lead: true,
        rows: [
          ...(kind.label ? [{ label: "Label", value: kind.label }] : []),
          ...(kind.codeId ? [{ label: "Code id", value: kind.codeId, mono: true }] : []),
          ...(kind.creator
            ? [{ label: "Creator", value: kind.creator, mono: true, address: kind.creator }]
            : []),
          kind.admin
            ? { label: "Admin", value: kind.admin, mono: true, address: kind.admin }
            : { label: "Admin", value: "None" },
          ...(kind.cw20
            ? [
                { label: "Token", value: `${kind.cw20.name} (${kind.cw20.symbol})` },
                { label: "Decimals", value: String(kind.cw20.decimals), mono: true },
                {
                  label: "Supply",
                  value: formatUnits(kind.cw20.totalSupply, kind.cw20.decimals),
                  mono: true,
                },
              ]
            : []),
        ],
      };
    case "vesting":
      return {
        key: "kind",
        label: "Vesting",
        value: kind.schedule,
        sub: kind.endTime ? `ends ${formatDate(kind.endTime)}` : "vesting account",
        rows: [
          { label: "Schedule", value: kind.schedule },
          ...(kind.startTime ? [{ label: "Starts", value: formatDateTime(kind.startTime) }] : []),
          ...(kind.endTime ? [{ label: "Ends", value: formatDateTime(kind.endTime) }] : []),
          {
            label: "Original",
            value: kind.original.map((c) => `${c.amount} ${c.denom}`).join(", ") || "-",
            mono: true,
          },
          {
            label: "Delegated vesting",
            value: kind.delegatedVesting.map((c) => `${c.amount} ${c.denom}`).join(", ") || "0",
            mono: true,
          },
          ...(kind.periods.length
            ? [{ label: "Periods", value: String(kind.periods.length), mono: true }]
            : []),
        ],
      };
  }
}

/**
 * One account, in one screen: what it holds, what it is, what it has at stake
 * and what it has done. Wrong-shaped URLs recover by redirect rather than
 * rendering an empty account: an operator or consensus address goes to its
 * validator, a foreign prefix to its own chain, upper case to lower.
 */
export default async function AccountPage({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}) {
  const { chain: chainId, addr: rawAddr } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const raw = decodeParam(rawAddr).trim();
  const realm = gnoPathHref(raw);
  if (realm) redirect(realm);

  const decoded = decodeBech32(raw);
  if (!decoded) notFound();
  const address = decoded.address;
  if (address !== raw) redirect(`/${chainId}/accounts/${address}`);

  const route = routeAddress(address, chainId, prefixes());
  if (!route) notFound();
  if (route.kind === "validator") redirect(route.href);
  if (route.kind === "consensus") {
    const target = getChain(route.chainId) ?? chain;
    const v = await findValidator(
      target,
      { valcons: address },
      (pk) => consensusIdsFromPubkey(pk, target.bech32Prefix)?.valcons ?? null
    ).catch(() => null);
    if (!v) notFound();
    redirect(`/${target.chainId}/validators/${v.operatorAddress}`);
  }
  if (route.chainId !== chainId) redirect(route.href);

  const accent = accentFor(chain);
  const symbol = symbolFor(chain);
  const adapter = getAdapter(chain);
  const natives = chainDenoms(chain);

  // AtomOne: who this account's governance vote goes to, and whether the
  // account is itself a governor (the same key under the gov prefix).
  const ownGovernor = chain.governors ? convertAddress(address, `${chain.bech32Prefix}gov`) : null;
  const [account, operated, delegatedTo, governors] = await Promise.all([
    adapter.getAccount(address) as Promise<AccountView>,
    operatedValidator(chain, address).catch(() => null),
    chain.governors ? withinBudget(governorOf(chain, address), 1500, null) : null,
    chain.governors ? withinBudget(getGovernors(chain), 1500, null) : null,
  ]);
  const governorName = (g: string | null) => (g ? (governors?.find((x) => x.address === g)?.moniker ?? null) : null);
  const isGovernor = ownGovernor !== null && (governors ?? []).some((g) => g.address === ownGovernor);
  const kind = account.kind ?? null;

  const assets = await resolveAssets(
    chain,
    [...account.balances.map((b) => b.denom), ...(account.rewards ?? []).map((c) => c.denom)],
    natives
  );
  const held = account.balances
    .flatMap((coin) => {
      const asset = assets.get(coin.denom);
      return asset ? [{ coin, asset }] : [];
    })
    .sort(assetOrder(natives.map((n) => n.denom)));

  // Same key, different prefix - only meaningful for a 20-byte user key.
  const links = isUserKey(address, kind) ? linkedAddresses(address) : [];

  const primary = account.balances.find((b) => b.denom === chain.denom);
  const others = held.filter((h) => h.coin.denom !== chain.denom);
  const exact = (c: Coin) => {
    const a = assets.get(c.denom);
    return `${formatUnits(c.amount, a?.exponent ?? null)} ${a?.symbol ?? c.denom}`;
  };
  const compactNative = (value: string | null | undefined) =>
    value ? formatToken(value, chain.exponent, 2) : "N/A";
  const nativeRewards = account.rewards?.find((c) => c.denom === chain.denom);
  const otherRewards = (account.rewards?.length ?? 0) - (nativeRewards ? 1 : 0);
  const tile = kindTile(kind, chainId);

  // Transaction total and first/last activity, from the index's per-address
  // count: exact once coverage reaches the chain's first block, "at least"
  // until then.
  const txCount = await addressTxCount(chain.chainId, address);

  const facts: BrickSpec[] = [
    ...(operated
      ? [
          {
            key: "validator",
            label: "Validator",
            value: operated.moniker,
            sub: operated.status,
            lead: true,
            tone: operated.status === "jailed" ? ("bad" as const) : undefined,
            rows: [
              { label: "Validator", value: operated.moniker, href: operated.href },
              { label: "Status", value: operated.status },
              ...(operated.commissionRate !== null
                ? [
                    {
                      label: "Commission rate",
                      value: `${(operated.commissionRate * 100).toFixed(2)}%`,
                      mono: true,
                    },
                  ]
                : []),
              ...(operated.outstanding
                ? [
                    {
                      label: "Commission outstanding",
                      value: operated.outstanding.length
                        ? operated.outstanding.map(exact).join(", ")
                        : "0",
                      mono: true,
                    },
                  ]
                : []),
              ...(operated.selfBond
                ? [
                    {
                      label: "Self-bond",
                      value: `${formatUnits(operated.selfBond, chain.exponent)} ${symbol}`,
                      mono: true,
                    },
                  ]
                : []),
            ],
            action: { label: "Validator page", href: operated.href },
          },
        ]
      : []),
    ...(tile ? [tile] : []),
    {
      key: "available",
      label: "Available",
      value: account.balancesFailed
        ? "N/A"
        : primary
          ? formatToken(primary.amount, chain.exponent, 2)
          : "0",
      sub: symbol,
      lead: !operated && !tile,
      rows: primary
        ? [
            {
              label: "Available",
              value: `${formatUnits(primary.amount, chain.exponent)} ${symbol}`,
              mono: true,
            },
            { label: "Base units", value: primary.amount, mono: true },
          ]
        : undefined,
    },
    ...(adapter.capabilities.staking
      ? [
          {
            key: "delegated",
            label: "Delegated",
            value: compactNative(account.delegatedTotal),
            sub:
              account.delegationCount != null
                ? `${account.delegationCount} validator${account.delegationCount === 1 ? "" : "s"}`
                : symbol,
            rows: account.delegatedTotal
              ? [
                  {
                    label: "Delegated",
                    value: `${formatUnits(account.delegatedTotal, chain.exponent)} ${symbol}`,
                    mono: true,
                  },
                ]
              : undefined,
          },
          {
            key: "unbonding",
            label: "Unbonding",
            value: compactNative(account.unbondingTotal),
            sub: symbol,
            rows: account.unbondingTotal
              ? [
                  {
                    label: "Unbonding",
                    value: `${formatUnits(account.unbondingTotal, chain.exponent)} ${symbol}`,
                    mono: true,
                  },
                ]
              : undefined,
          },
          {
            key: "rewards",
            label: "Rewards",
            value:
              account.rewards === null || account.rewards === undefined
                ? "N/A"
                : nativeRewards
                  ? formatToken(nativeRewards.amount, chain.exponent, 2)
                  : "0",
            sub: otherRewards > 0 ? `${symbol} +${otherRewards} denoms` : symbol,
            rows:
              account.rewards && account.rewards.length
                ? account.rewards.map((c) => ({
                    label: assets.get(c.denom)?.symbol ?? c.denom,
                    value: exact(c),
                    mono: true,
                  }))
                : undefined,
          },
        ]
      : []),
    {
      key: "others",
      label: "Other assets",
      value: String(others.length),
      sub: "denominations",
    },
    ...(txCount
      ? [
          {
            key: "tx-count",
            label: "Transactions",
            value: `${txCount.exact ? "" : "≥ "}${txCount.count.toLocaleString()}`,
            sub: txCount.exact
              ? txCount.last?.time
                ? `last ${timeAgo(txCount.last.time)}`
                : "none"
              : `since block ${txCount.since.height.toLocaleString()}`,
            rows: [
              {
                label: "Transactions",
                value: `${txCount.exact ? "" : "at least "}${txCount.count.toLocaleString()}`,
                mono: true,
              },
              ...(txCount.first
                ? [
                    {
                      label: txCount.exact ? "First" : "First counted",
                      value: `#${txCount.first.height.toLocaleString()}${
                        txCount.first.time ? `, ${formatDateTime(txCount.first.time)}` : ""
                      }`,
                      mono: true,
                      href: `/${chain.chainId}/blocks/${txCount.first.height}`,
                    },
                  ]
                : []),
              ...(txCount.last
                ? [
                    {
                      label: "Last",
                      value: `#${txCount.last.height.toLocaleString()}${
                        txCount.last.time ? `, ${formatDateTime(txCount.last.time)}` : ""
                      }`,
                      mono: true,
                      href: `/${chain.chainId}/blocks/${txCount.last.height}`,
                    },
                  ]
                : []),
            ],
          } satisfies BrickSpec,
        ]
      : []),
    ...(isGovernor
      ? [
          {
            key: "is-governor",
            label: "Governor",
            value: governorName(ownGovernor) ?? "Governor",
            sub: "this account governs",
            href: `/${chainId}/governors/${ownGovernor}`,
          } satisfies BrickSpec,
        ]
      : chain.governors && delegatedTo
        ? [
            {
              key: "governor",
              label: "Governor",
              value: governorName(delegatedTo) ?? truncateMiddle(delegatedTo, 10, 6),
              sub: "votes for this account",
              href: `/${chainId}/governors/${delegatedTo}`,
            } satisfies BrickSpec,
          ]
        : []),
    {
      key: "account",
      label: "Account",
      value: account.accountNumber ?? "-",
      sub: `sequence ${account.sequence ?? "-"}`,
      rows: [
        { label: "Address", value: address, mono: true },
        { label: "Account number", value: account.accountNumber ?? "-", mono: true },
        { label: "Sequence", value: account.sequence ?? "-", mono: true },
      ],
    },
  ];

  const balanceColumns: DeckColumn[] = [
    { label: "Asset" },
    { label: "Route", optional: true },
    { label: "Amount", align: "right", width: "40%" },
  ];

  const balanceRows: DeckRow[] = held.map(({ coin, asset }) => ({
    key: coin.denom,
    cells: [
      { v: asset.symbol, tone: "accent" as const },
      { v: routeLabel(asset), dim: true },
      {
        v:
          asset.exponent === null
            ? `${formatUnits(coin.amount, null)} base`
            : formatUnits(coin.amount, asset.exponent),
        mono: true,
        align: "right" as const,
      },
    ],
    detail: {
      title: asset.symbol,
      sub: coin.denom,
      rows: [
        { label: "Amount", value: formatUnits(coin.amount, asset.exponent), mono: true },
        { label: "Base units", value: coin.amount, mono: true },
        { label: "Denom", value: coin.denom, mono: true },
        {
          label: "Decimals",
          value: asset.exponent === null ? "N/A" : String(asset.exponent),
          mono: true,
        },
        ...(asset.base ? [{ label: "Home denom", value: asset.base, mono: true }] : []),
        ...(asset.channels.length
          ? [{ label: "Channels", value: asset.channels.join(" → "), mono: true }]
          : []),
      ],
    },
  }));

  // Indexed tabs appear only where the index covers them.
  const [stakeCov, ibcCov] = adapter.capabilities.staking
    ? await Promise.all([
        coverageOf(chain.chainId, "staking_event"),
        coverageOf(chain.chainId, "ibc_packet"),
      ])
    : [null, null];

  const sections = [
    ...(account.balances.length > 0 || account.balancesFailed
      ? [
          {
            key: "balances",
            label: account.balancesFailed ? "Balances" : `Balances (${account.balances.length})`,
            content: (
              <RowDeck
                columns={balanceColumns}
                rows={balanceRows}
                accent={accent}
                empty={account.balancesFailed ? "N/A" : "No balances"}
              />
            ),
          },
        ]
      : []),
    ...(adapter.capabilities.staking
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
    ...(stakeCov
      ? [
          {
            key: "staking-history",
            label: "Staking history",
            content: (
              <Suspense fallback={<LoadingPanel label="Loading staking history…" rows={3} />}>
                <StakingHistoryDeck chain={chain} address={address} accent={accent} />
              </Suspense>
            ),
          },
        ]
      : []),
    ...(ibcCov
      ? [
          {
            key: "ibc",
            label: "IBC",
            content: (
              <Suspense fallback={<LoadingPanel label="Loading IBC transfers…" rows={3} />}>
                <IbcDeck chain={chain} address={address} accent={accent} />
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
          <TransactionDeck
            chain={chain}
            address={address}
            accent={accent}
            kind={kind?.kind ?? null}
            sequence={account.sequence}
          />
        </Suspense>
      ),
    },
  ];

  const title = operated
    ? operated.moniker
    : kind?.kind === "module"
      ? `Module ${kind.name}`
      : "Account";

  return (
    <PageFrame
      title={title}
      sub={address}
      accent={accent}
      actions={
        <>
          <CopyButton value={address} label="address" />
          <LinkedAddresses links={links} currentChainId={chainId} />
        </>
      }
    >
      {/* The list takes whatever height is left at every width. On a screen
          too short for its minimum the body scrolls instead. */}
      <div className="flex h-full flex-col gap-2.5 overflow-y-auto sm:gap-3 lg:overflow-hidden">
        {account.exists ? (
          <BrickBoard bricks={facts} accent={accent} className="shrink-0" />
        ) : (
          // An unused address keeps the tabs below: the transaction list is
          // read from block history, not from account state.
          <div className="min-h-0 shrink-0 overflow-y-auto">
            <p className="text-sm text-muted-foreground">No on-chain activity</p>
            <Suspense fallback={null}>
              <AddressElsewhere links={links} currentChainId={chainId} />
            </Suspense>
          </div>
        )}

        <div className="min-h-[18rem] flex-1 lg:min-h-0">
          <SectionTabs sections={sections} />
        </div>
      </div>
    </PageFrame>
  );
}
