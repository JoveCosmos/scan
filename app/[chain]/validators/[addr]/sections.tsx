import { cache } from "react";
import type { ChainConfig } from "@/lib/chains";
import { chainDenoms, getChain } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { shortDenom } from "@/lib/coin";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { getAdapter } from "@/lib/adapter";
import { getValidator, getValidatorsCached } from "@/lib/validators";
import { cached } from "@/lib/cache";
import { getAprModel, getChainParams, type AprModel } from "@/lib/params";
import {
  DETAIL_BAR_COUNT,
  emptyUptime,
  jailedNow,
  longestMissStreak,
  missBudget,
  type ValidatorUptime,
} from "@/lib/uptime";
import {
  commissionEarned,
  proposerStats,
  slashHistory,
  stakeHistory,
  type SlashKind,
} from "@/lib/indexer-db";
import {
  consHexOf,
  powerEvents,
  powerHistory,
  proposedBlocks,
  proposerFairness,
  signingHistory,
  validatorEvents,
  validatorVotes,
  voterRecasts,
  type ValidatorEventKind,
} from "@/lib/indexer-validator";
import { formatDuration, jailSpells } from "@/lib/signing-stats";
import { voteOptionLabel } from "@/lib/proposals";
import { BrickBoard, type BrickSpec, type DetailRow } from "@/components/brick-board";
import { RowDeck, type DeckRow } from "@/components/row-deck";
import { Skeleton } from "@/components/ui/skeleton";
import { UptimeBars } from "@/components/uptime-bars";
import { ValidatorSigningHistory } from "@/components/validator-signing-history";
import { ValidatorPowerHistory } from "@/components/validator-power-history";
import { ValidatorStakeChart } from "@/components/validator-stake-history";

/**
 * The validator page's indexed parts, each streamed on its own.
 *
 * The page used to await every one of these before drawing anything, and they
 * share a pool of four index connections, so one slow query held the whole
 * page for half a minute. Now the chain's own figures draw at once and each of
 * these fills in when its query returns.
 *
 * Several sections need the same query (the jailings tab and the events tab
 * both read the validator's events). The loaders are wrapped in React's
 * per-request cache so each query runs once per page view, whoever asks first.
 */

// ── Loaders ──────────────────────────────────────────────────────────────────

const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const loadUptime = cache(
  async (chainId: string, addr: string): Promise<ValidatorUptime> => {
    const chain = getChain(chainId);
    const validator = chain ? await getValidator(chain, addr) : null;
    if (!chain || !validator) return emptyUptime();
    return getAdapter(chain)
      .getUptime([validator], DETAIL_BAR_COUNT)
      .then((m) => m.get(addr) ?? emptyUptime())
      .catch(() => emptyUptime());
  }
);

const loadEvents = cache((chainId: string, account: string) =>
  soft(validatorEvents(chainId, account))
);
const loadSlashes = cache((chainId: string, valcons: string, addr: string) =>
  soft(slashHistory(chainId, valcons, addr))
);
const loadProposer = cache((chainId: string, hex: string) => soft(proposerStats(chainId, hex)));
const loadFairness = cache((chainId: string, addr: string, hex: string) =>
  soft(proposerFairness(chainId, addr, hex))
);
const loadProposed = cache((chainId: string, hex: string) => soft(proposedBlocks(chainId, hex)));
const loadEarned = cache((chainId: string, account: string) =>
  soft(commissionEarned(chainId, account))
);
const loadPowerEvents = cache((chainId: string, addr: string) => soft(powerEvents(chainId, addr)));
const loadStake = cache((chainId: string, addr: string) => soft(stakeHistory(chainId, addr)));
const loadRecasts = cache((chainId: string, account: string) =>
  soft(voterRecasts(chainId, account))
);

/**
 * The chain's APR model over its bonded set, so this validator's APR comes from
 * its own stake, the same figure its row in the validators list shows. Null on
 * chains whose APR is one figure for everyone.
 */
export function getAprModelCached(chain: ChainConfig): Promise<AprModel | null> {
  return cached(
    `aprmodel:${chain.chainId}`,
    5 * 60_000,
    async () => {
      const [params, set] = await Promise.all([
        getChainParams(chain).catch(() => null),
        getValidatorsCached(chain).catch(() => []),
      ]);
      return getAprModel(
        chain,
        params?.distribution?.communityTax ?? null,
        set.map((v) => v.tokens)
      );
    },
    { staleMs: 60 * 60_000 }
  );
}

/** The key the index files signing under: derived from the pubkey, else looked up. */
const loadConsHex = cache(async (chainId: string, addr: string, hex: string | null) =>
  hex ?? soft(consHexOf(chainId, addr))
);
const loadSigningHist = cache(async (chainId: string, addr: string, hex: string | null) => {
  const h = await loadConsHex(chainId, addr, hex);
  return h ? soft(signingHistory(chainId, h)) : null;
});
const loadPowerHist = cache(async (chainId: string, addr: string, hex: string | null) => {
  const h = await loadConsHex(chainId, addr, hex);
  return h ? soft(powerHistory(chainId, h)) : null;
});

/** Votes are counted from the validator's creation, where the index holds it. */
const loadVotes = cache(async (chainId: string, account: string) => {
  const events = await loadEvents(chainId, account);
  const created = events?.filter((e) => e.kind === "create").at(-1)?.time ?? null;
  return soft(validatorVotes(chainId, account, created));
});

// ── Shared helpers ───────────────────────────────────────────────────────────

export interface ValidatorKeys {
  chain: ChainConfig;
  accent: string;
  /** Operator address, lower-cased: the page's own address. */
  addr: string;
  /** The operator's own account, where the prefix allows deriving it. */
  account: string | null;
  /** Consensus ids, where the validator's pubkey decodes. */
  ids: { valcons: string; hex: string } | null;
}

export const pct = (value: number | null, decimals = 2) =>
  value === null ? "—" : `${(value * 100).toFixed(decimals)}%`;

/** Drops rows whose value is a dash, so a popup never lists absent facts. */
export const kept = (rows: DetailRow[]) => rows.filter((r) => r.value !== "—" && r.value !== "");

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The chain's own denoms scaled and named; anything else (an IBC hash) as-is. */
function coinFormatter(chain: ChainConfig) {
  const known = new Map(chainDenoms(chain).map((d) => [d.denom, d]));
  const coin = (c: { denom: string; amount: string }, frac = 2) => {
    const info = known.get(c.denom);
    return info
      ? `${formatToken(c.amount, info.exponent, frac)} ${info.symbol}`
      : `${c.amount} ${shortDenom(c.denom)}`;
  };
  return { coin, symbolOf: (denom: string) => known.get(denom)?.symbol ?? shortDenom(denom) };
}

function NotAvailable() {
  return (
    <div className="gata-surface grid h-full min-h-[8rem] place-items-center text-[13px] text-muted-foreground">
      N/A
    </div>
  );
}

export function TabLoading() {
  return (
    <div className="gata-surface flex h-full flex-col gap-3 overflow-hidden p-3" role="status" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${[92, 80, 86, 74][i % 4]}%` }} />
      ))}
    </div>
  );
}

/** Stands in for a figure tile at the same size, so nothing moves when it lands. */
export function BrickLoading({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="gata-surface gata-brick flex h-[5rem] flex-col justify-between px-3.5 py-2.5"
          aria-hidden="true"
        >
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-2 w-16" />
        </div>
      ))}
    </>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5">
      {value !== undefined ? (
        <span className="font-mono font-semibold text-foreground">{value}</span>
      ) : null}
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

// ── Figures from the index ───────────────────────────────────────────────────

/** Blocks proposed against blocks owed by stake. */
function verdict(ratio: number): string {
  if (ratio >= 0.95) return "in line";
  if (ratio >= 0.85) return "slightly under";
  return "under";
}

/** Commission taken, blocks proposed and governance: always three tiles, N/A when unknown. */
export async function IndexedBricks({ chain, accent, addr, account, ids }: ValidatorKeys) {
  const chainId = chain.chainId;
  const { coin, symbolOf } = coinFormatter(chain);
  const [earned, proposer, fairness, votes] = await Promise.all([
    account ? loadEarned(chainId, account) : null,
    ids ? loadProposer(chainId, ids.hex) : null,
    ids ? loadFairness(chainId, addr, ids.hex) : null,
    account ? loadVotes(chainId, account) : null,
  ]);

  const bricks: BrickSpec[] = [];

  bricks.push(
    earned && earned.byDenom.length > 0
      ? {
          key: "earned",
          label: "Commission taken",
          value: coin(earned.byDenom[0]),
          sub: `${earned.withdrawals.toLocaleString()} withdrawals`,
          rows: kept([
            ...earned.byDenom.map((d) => ({
              label: symbolOf(d.denom),
              value: coin(d, 4),
              mono: true,
            })),
            { label: "Withdrawals", value: earned.withdrawals.toLocaleString(), mono: true },
            { label: "First", value: earned.first ? day(earned.first) : "—" },
            { label: "Last", value: earned.last ? timeAgo(earned.last) : "—" },
          ]),
        }
      : { key: "earned", label: "Commission taken", value: "N/A" }
  );

  if (proposer && proposer.totalBlocks > 0) {
    const share = proposer.proposed / proposer.totalBlocks;
    bricks.push({
      key: "proposed",
      label: "Blocks proposed",
      value: proposer.proposed.toLocaleString(),
      sub: fairness
        ? `${fairness.ratio.toFixed(2)}× expected · ${verdict(fairness.ratio)}`
        : `${pct(share)} of the chain's`,
      tone: fairness
        ? fairness.ratio >= 0.95
          ? "ok"
          : fairness.ratio < 0.85
            ? "bad"
            : undefined
        : undefined,
      rows: kept([
        { label: "Proposed", value: proposer.proposed.toLocaleString(), mono: true },
        { label: "Share of blocks", value: pct(share), mono: true },
        ...(fairness
          ? [
              {
                label: "Expected from stake",
                value: Math.round(fairness.expected).toLocaleString(),
                mono: true,
              },
              {
                label: "Proposed in that window",
                value: fairness.proposed.toLocaleString(),
                mono: true,
              },
              {
                label: "Versus stake",
                value: `${fairness.ratio.toFixed(2)}× · ${verdict(fairness.ratio)}`,
              },
              {
                label: "Window",
                value: `#${fairness.fromHeight.toLocaleString()} – #${fairness.toHeight.toLocaleString()}`,
                mono: true,
              },
            ]
          : []),
        {
          label: "Last proposed",
          value: proposer.lastHeight
            ? `#${proposer.lastHeight.toLocaleString()}${proposer.lastTime ? ` · ${timeAgo(proposer.lastTime)}` : ""}`
            : "Never",
          mono: true,
          ...(proposer.lastHeight ? { href: `/${chainId}/blocks/${proposer.lastHeight}` } : {}),
        },
        {
          label: "Measured over",
          value: proposer.fromGenesis
            ? `${proposer.totalBlocks.toLocaleString()} blocks`
            : `${proposer.totalBlocks.toLocaleString()} blocks since ${day(proposer.since)}`,
        },
      ]),
    });
  } else {
    bricks.push({ key: "proposed", label: "Blocks proposed", value: "N/A" });
  }

  if (votes && votes.total > 0) {
    const byOption = new Map<string, number>();
    for (const v of votes.votes) byOption.set(v.option, (byOption.get(v.option) ?? 0) + 1);
    const last = votes.votes.reduce<string | null>((m, v) => (m === null || v.time > m ? v.time : m), null);
    bricks.push({
      key: "governance",
      label: "Governance",
      value: pct(votes.voted / votes.total, 0),
      sub: `voted on ${votes.voted} of ${votes.total}`,
      tone: votes.voted === votes.total ? "ok" : undefined,
      rows: kept([
        { label: "Participation", value: `${votes.voted} of ${votes.total} proposals`, mono: true },
        { label: "Skipped", value: String(votes.skipped.length), mono: true },
        ...[...byOption.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([option, n]) => ({ label: voteOptionLabel(option), value: String(n), mono: true })),
        { label: "Counted since", value: day(votes.since) },
        { label: "Last voted", value: last ? timeAgo(last) : "—" },
      ]),
    });
  } else {
    bricks.push({ key: "governance", label: "Governance", value: "N/A" });
  }

  return <BrickBoard accent={accent} bricks={bricks} bare />;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export async function SigningTab({ chain, addr, ids, jailedOnChain }: ValidatorKeys & { jailedOnChain: boolean }) {
  const chainId = chain.chainId;
  const [uptime, hist] = await Promise.all([
    loadUptime(chainId, addr),
    loadSigningHist(chainId, addr, ids?.hex ?? null),
  ]);
  if (uptime.bars.length === 0 && !hist) return <NotAvailable />;
  const jailed = jailedNow(uptime, jailedOnChain);
  const streak = uptime.bars.length > 0 ? longestMissStreak(uptime.bars) : null;
  const budget = missBudget(uptime.window, uptime.minSigned, uptime.missed);
  return (
    <div className="gata-surface flex h-full flex-col gap-2 overflow-y-auto px-4 py-3">
      {uptime.bars.length > 0 ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11.5px]">
            <Fact label={`last ${uptime.bars.length} blocks`} />
            <Fact value={String(uptime.bars.filter((b) => !b).length)} label="missed" />
            {streak !== null ? <Fact label="longest streak" value={String(streak)} /> : null}
            {!jailed && budget !== null ? (
              <Fact label="miss budget" value={budget.toLocaleString()} />
            ) : null}
            {jailed ? <Fact label="jailed" /> : null}
          </div>
          <UptimeBars
            // Jailed, the window is reset: show the strip, not its percentage.
            uptime={jailed ? { ...uptime, ratio: null, missed: null } : uptime}
            slashingWindow
            expand
            chainId={chainId}
          />
        </>
      ) : null}
      {hist ? (
        <div className={uptime.bars.length > 0 ? "mt-2 border-t border-border/60 pt-3" : undefined}>
          <ValidatorSigningHistory history={hist} chainId={chainId} />
        </div>
      ) : null}
    </div>
  );
}

export async function ProposedTab({ chain, accent, ids }: ValidatorKeys) {
  const chainId = chain.chainId;
  const list = ids ? await loadProposed(chainId, ids.hex) : null;
  if (!list) return <NotAvailable />;
  const rows: DeckRow[] = list.blocks.map((b) => ({
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
  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Block" },
        { label: "Age", align: "right", width: "30%" },
        { label: "Txs", align: "right", width: "18%" },
      ]}
      rows={rows}
      empty="None"
    />
  );
}

export async function VotesTab({ chain, accent, account }: ValidatorKeys) {
  const chainId = chain.chainId;
  const [votes, recasts] = account
    ? await Promise.all([loadVotes(chainId, account), loadRecasts(chainId, account)])
    : [null, null];
  if (!votes) return <NotAvailable />;
  const cast = votes.votes.map((v) => ({
    id: v.proposalId,
    row: {
      key: `v-${v.proposalId}`,
      cells: [
        { v: `#${v.proposalId}`, mono: true, tone: "accent" as const },
        {
          v: `${voteOptionLabel(v.option)}${v.weighted ? " · split" : ""}${
            recasts?.get(v.proposalId)
              ? ` · was ${recasts.get(v.proposalId)!.map(voteOptionLabel).join(", ")}`
              : ""
          }`,
        },
        { v: truncateMiddle(v.txHash, 6, 4), mono: true, dim: true, href: `/${chainId}/txs/${v.txHash}` },
        { v: day(v.time), dim: true, align: "right" as const },
      ],
      detail: {
        title: `Proposal #${v.proposalId}`,
        rows: [],
        action: { label: "Proposal", href: `/${chainId}/proposals/${v.proposalId}` },
      },
    } satisfies DeckRow,
  }));
  const skipped = [...new Set(votes.skipped)].map((id) => ({
    id,
    row: {
      key: `s-${id}`,
      cells: [
        { v: `#${id}`, mono: true, tone: "accent" as const },
        { v: "Did not vote", tone: "bad" as const },
        { v: "—", dim: true },
        { v: "—", dim: true, align: "right" as const },
      ],
      detail: {
        title: `Proposal #${id}`,
        rows: [],
        action: { label: "Proposal", href: `/${chainId}/proposals/${id}` },
      },
    } satisfies DeckRow,
  }));
  const rows = [...cast, ...skipped].sort((a, b) => b.id - a.id).map((x) => x.row);
  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Proposal", width: "16%" },
        { label: "Vote" },
        { label: "Tx", width: "22%", phoneHide: true },
        { label: "Date", align: "right", width: "22%" },
      ]}
      rows={rows}
      empty="None"
    />
  );
}

const EVENT_LABEL: Record<ValidatorEventKind, string> = {
  create: "Created",
  edit: "Edited",
  unjail: "Unjailed",
  commission: "Commission withdrawn",
};

export async function EventsTab({ chain, accent, account }: ValidatorKeys) {
  const chainId = chain.chainId;
  const { coin } = coinFormatter(chain);
  const events = account ? await loadEvents(chainId, account) : null;
  if (!events) return <NotAvailable />;
  const rows: DeckRow[] = events.map((e) => ({
    key: e.txHash,
    cells: [
      { v: EVENT_LABEL[e.kind], tone: e.ok ? undefined : "bad" },
      {
        v: e.amounts.length > 0 ? e.amounts.map((a) => coin(a)).join(", ") : "—",
        mono: true,
        align: "right",
        dim: e.amounts.length === 0,
      },
      { v: `#${e.height.toLocaleString()}`, mono: true, align: "right", href: `/${chainId}/blocks/${e.height}` },
      { v: day(e.time), dim: true, align: "right" },
    ],
    detail: {
      title: EVENT_LABEL[e.kind],
      rows: [],
      action: { label: "Transaction", href: `/${chainId}/txs/${e.txHash}` },
    },
  }));
  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Event" },
        { label: "Amount", align: "right", width: "26%", phoneHide: true },
        { label: "Block", align: "right", width: "20%" },
        { label: "Date", align: "right", width: "20%" },
      ]}
      rows={rows}
      empty="None"
    />
  );
}

/** Stake moving in and out, signed from this validator's side. */
function powerKind(e: { kind: string; validatorDst: string | null }, addr: string) {
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

export async function PowerEventsTab({ chain, accent, addr }: ValidatorKeys) {
  const chainId = chain.chainId;
  const { coin } = coinFormatter(chain);
  const power = await loadPowerEvents(chainId, addr);
  if (!power) return <NotAvailable />;
  const signed = (amount: string | null, sign: number) =>
    !amount || sign === 0 ? "—" : `${sign > 0 ? "+" : "−"}${coin({ denom: chain.denom, amount })}`;
  const flow = (net: string | null) => {
    if (net === null) return null;
    const neg = net.startsWith("-");
    const abs = neg ? net.slice(1) : net;
    return `${neg ? "−" : abs === "0" ? "" : "+"}${coin({ denom: chain.denom, amount: abs })}`;
  };
  const rows: DeckRow[] = power.events.map((e) => {
    const k = powerKind(e, addr);
    return {
      key: `${e.txHash}-${e.height}-${e.kind}-${e.delegator ?? ""}`,
      cells: [
        { v: k.label, tone: k.sign > 0 ? "ok" : k.sign < 0 ? "bad" : undefined },
        e.delegator
          ? { v: truncateMiddle(e.delegator, 10, 6), address: e.delegator, mono: true }
          : { v: "—", dim: true },
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
  const flow7 = flow(power.flow7);
  const flow30 = flow(power.flow30);
  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Event", width: "18%" },
        { label: "Delegator", phoneHide: true },
        { label: "Amount", align: "right", width: "22%" },
        { label: "Block", align: "right", width: "15%", optional: true },
        { label: "Date", align: "right", width: "16%" },
      ]}
      rows={rows}
      toolbar={
        flow7 || flow30 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            {flow7 ? <Fact label="net 7d" value={flow7} /> : null}
            {flow30 ? <Fact label="net 30d" value={flow30} /> : null}
          </div>
        ) : undefined
      }
      empty="None"
    />
  );
}

/** Voting power over time from the index, else bonded stake from snapshots. */
export async function PowerTab({ chain, accent, addr, ids, symbol }: ValidatorKeys & { symbol: string }) {
  const chainId = chain.chainId;
  const hist = await loadPowerHist(chainId, addr, ids?.hex ?? null);
  if (hist && hist.length >= 1) return <ValidatorPowerHistory points={hist} accent={accent} />;
  const stake = await loadStake(chainId, addr);
  if (stake && stake.length >= 2) {
    return (
      <ValidatorStakeChart points={stake} exponent={chain.exponent} symbol={symbol} accent={accent} />
    );
  }
  return <NotAvailable />;
}

const SLASH_LABEL: Record<SlashKind, string> = {
  jailed: "Jailed",
  unjailed: "Unjailed",
  slashed: "Slashed",
  tombstoned: "Tombstoned",
};

function reasonLabel(reason: string | null): string {
  if (reason === "downtime") return "Missed blocks";
  if (reason === "double_sign") return "Double signing";
  return "—";
}

export async function JailingsTab({
  chain,
  accent,
  addr,
  account,
  ids,
  jailedOnChain,
}: ValidatorKeys & { jailedOnChain: boolean }) {
  const chainId = chain.chainId;
  const { coin } = coinFormatter(chain);
  const [slashes, events] = await Promise.all([
    ids ? loadSlashes(chainId, ids.valcons, addr) : null,
    account ? loadEvents(chainId, account) : null,
  ]);
  if (!slashes) return <NotAvailable />;

  type JailRow = {
    height: number;
    time: string;
    label: string;
    reason: string;
    burned: string | null;
    tx: string | null;
    bad: boolean;
  };
  const jailRows: JailRow[] = [
    ...slashes.events.map((e) => ({
      height: e.height,
      time: e.time,
      label: SLASH_LABEL[e.kind],
      reason: reasonLabel(e.reason),
      burned: e.burned,
      tx: null,
      bad: e.kind !== "unjailed",
    })),
    // Before extract version 4 the index kept no unjail; the MsgUnjail
    // transaction stands in, unless the index already has that unjail.
    ...(events ?? [])
      .filter((e) => e.kind === "unjail")
      .filter(
        (u) => !slashes.events.some((e) => e.kind === "unjailed" && e.height === u.height)
      )
      .map((e) => ({
        height: e.height,
        time: e.time,
        label: "Unjailed",
        reason: "—",
        burned: null,
        tx: e.txHash,
        bad: false,
      })),
  ].sort((a, b) => b.height - a.height);

  // Each jailing paired with the unjail that ended it: how long it was down.
  const downtimeAt = new Map(
    jailSpells(
      jailRows
        .filter((r) => r.label === "Jailed" || r.label === "Unjailed")
        .map((r) => ({
          kind: r.label === "Jailed" ? "jailed" : "unjailed",
          height: r.height,
          time: r.time,
        }))
    ).map((spell) => [spell.jailedAt.height, spell])
  );

  const rows: DeckRow[] = jailRows.map((e) => ({
    key: `${e.height}-${e.label}`,
    cells: [
      { v: e.label, tone: e.bad ? "bad" : "ok" },
      { v: e.reason, dim: true },
      (() => {
        const spell = e.label === "Jailed" ? downtimeAt.get(e.height) : undefined;
        if (!spell) return { v: "—", dim: true, align: "right" as const };
        return spell.unjailedAt
          ? { v: formatDuration(spell.downtimeMs), mono: true, align: "right" as const }
          : // Open only while the chain still says jailed; otherwise the unjail
            // predates what the index holds.
            jailedOnChain
            ? { v: "ongoing", tone: "bad" as const, align: "right" as const }
            : { v: "—", dim: true, align: "right" as const };
      })(),
      {
        v: e.burned ? coin({ denom: chain.denom, amount: e.burned }) : "—",
        mono: true,
        align: "right",
        dim: !e.burned,
      },
      { v: `#${e.height.toLocaleString()}`, mono: true, align: "right", href: `/${chainId}/blocks/${e.height}` },
      { v: day(e.time), dim: true, align: "right" },
    ],
    detail: {
      title: e.label,
      sub: day(e.time),
      rows: [],
      action: e.tx
        ? { label: "Transaction", href: `/${chainId}/txs/${e.tx}` }
        : { label: "Block", href: `/${chainId}/blocks/${e.height}` },
    },
  }));

  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "Event", width: "16%" },
        { label: "Reason" },
        { label: "Down", align: "right", width: "13%" },
        { label: "Burned", align: "right", width: "17%", phoneHide: true },
        { label: "Block", align: "right", width: "18%", optional: true },
        { label: "Date", align: "right", width: "22%" },
      ]}
      rows={rows}
      empty="Never"
    />
  );
}
