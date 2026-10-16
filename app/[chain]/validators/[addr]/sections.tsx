import { cache } from "react";
import type { ChainConfig } from "@/lib/chains";
import { getChain } from "@/lib/chains";
import { formatDate, formatPercent, timeAgo, truncateMiddle } from "@/lib/format";
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
import { type SlashKind } from "@/lib/indexer-db";
import { VALIDATOR_PAGE, type ValidatorEventKind } from "@/lib/indexer-validator";
import {
  readConsHex,
  readEarned,
  readEvents,
  readFairness,
  readPowerEvents,
  readPowerHistAt,
  readProposed,
  readProposer,
  readRecasts,
  readSigningHistAt,
  readSlashes,
  readStake,
  readVotes,
} from "@/lib/validator-index-reads";
import { formatDuration, jailSpells } from "@/lib/signing-stats";
import { voteOptionLabel } from "@/lib/proposals";
import { BrickBoard, type BrickSpec, type DetailRow } from "@/components/brick-board";
import { RowDeck, type DeckRow } from "@/components/row-deck";
import { OlderDeck } from "@/components/older-deck";
import { coinFormatter, POWER_COLUMNS, powerRows, PROPOSED_COLUMNS, proposedRows } from "./rows";
import { Skeleton } from "@/components/ui/skeleton";
export { BrickLoading } from "@/components/brick-loading";
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

const loadEvents = cache(readEvents);
const loadSlashes = cache(readSlashes);
const loadProposer = cache(readProposer);
const loadFairness = cache(readFairness);
const loadProposed = cache(readProposed);
const loadEarned = cache(readEarned);
const loadPowerEvents = cache(readPowerEvents);
const loadStake = cache(readStake);
const loadRecasts = cache(readRecasts);

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

const loadConsHex = cache(readConsHex);
const loadSigningHist = cache(async (chainId: string, addr: string, hex: string | null) => {
  const h = await loadConsHex(chainId, addr, hex);
  return h ? readSigningHistAt(chainId, h) : null;
});
const loadPowerHist = cache(async (chainId: string, addr: string, hex: string | null) => {
  const h = await loadConsHex(chainId, addr, hex);
  return h ? readPowerHistAt(chainId, h) : null;
});
const loadVotes = cache(readVotes);

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

export const pct = formatPercent;

/** Drops rows whose value is a dash, so a popup never lists absent facts. */
export const kept = (rows: DetailRow[]) => rows.filter((r) => r.value !== "-" && r.value !== "");

const day = formatDate;

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

/**
 * Commission taken, blocks proposed and governance: three tiles, each streamed
 * on its own so a fast one never waits for a slow one, N/A when unknown.
 */
export async function EarnedBrick({ chain, accent, account }: ValidatorKeys) {
  const { coin, symbolOf } = coinFormatter(chain);
  const earned = account ? await loadEarned(chain.chainId, account) : null;
  const brick: BrickSpec =
    earned && earned.byDenom.length > 0
      ? {
          key: "earned",
          label: "Commission taken",
          short: "Comm. earned",
          value: coin(earned.byDenom[0]),
          sub: `${earned.withdrawals.toLocaleString()} withdrawals`,
          rows: kept([
            ...earned.byDenom.map((d) => ({
              label: symbolOf(d.denom),
              value: coin(d, 4),
              mono: true,
            })),
            { label: "Withdrawals", value: earned.withdrawals.toLocaleString(), mono: true },
            { label: "First", value: earned.first ? day(earned.first) : "-" },
            { label: "Last", value: earned.last ? timeAgo(earned.last) : "-" },
          ]),
        }
      : { key: "earned", label: "Commission taken", short: "Comm. earned", value: "N/A" };
  return <BrickBoard accent={accent} bricks={[brick]} bare />;
}

export async function ProposedBrick({ chain, accent, addr, ids }: ValidatorKeys) {
  const chainId = chain.chainId;
  const [proposer, fairness] = await Promise.all([
    ids ? loadProposer(chainId, ids.hex) : null,
    ids ? loadFairness(chainId, addr, ids.hex) : null,
  ]);
  if (!proposer || proposer.totalBlocks <= 0) {
    return <BrickBoard accent={accent} bricks={[{ key: "proposed", label: "Blocks proposed", short: "Proposed", value: "N/A" }]} bare />;
  }
  const share = proposer.proposed / proposer.totalBlocks;
  const brick: BrickSpec = {
    key: "proposed",
    label: "Blocks proposed",
    short: "Proposed",
    value: proposer.proposed.toLocaleString(),
    sub: fairness
      ? `${fairness.ratio.toFixed(2)}× expected, ${verdict(fairness.ratio)}`
      : `${pct(share)} of the chain's`,
    tone: fairness ? (fairness.ratio >= 0.95 ? "ok" : fairness.ratio < 0.85 ? "bad" : undefined) : undefined,
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
              value: `${fairness.ratio.toFixed(2)}×, ${verdict(fairness.ratio)}`,
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
          ? `#${proposer.lastHeight.toLocaleString()}${proposer.lastTime ? `, ${timeAgo(proposer.lastTime)}` : ""}`
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
  };
  return <BrickBoard accent={accent} bricks={[brick]} bare />;
}

export async function GovernanceBrick({ chain, accent, account }: ValidatorKeys) {
  const votes = account ? await loadVotes(chain.chainId, account) : null;
  if (!votes || votes.total <= 0) {
    return <BrickBoard accent={accent} bricks={[{ key: "governance", label: "Governance", value: "N/A" }]} bare />;
  }
  const byOption = new Map<string, number>();
  for (const v of votes.votes) byOption.set(v.option, (byOption.get(v.option) ?? 0) + 1);
  const last = votes.votes.reduce<string | null>((m, v) => (m === null || v.time > m ? v.time : m), null);
  const brick: BrickSpec = {
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
      { label: "Last voted", value: last ? timeAgo(last) : "-" },
    ]),
  };
  return <BrickBoard accent={accent} bricks={[brick]} bare />;
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

export async function ProposedTab({ chain, accent, addr, ids }: ValidatorKeys) {
  const chainId = chain.chainId;
  const list = ids ? await loadProposed(chainId, ids.hex) : null;
  if (!list) return <NotAvailable />;
  const last = list.blocks.at(-1);
  return (
    <OlderDeck
      endpoint={`/${chainId}/validators/${addr}/proposed`}
      columns={PROPOSED_COLUMNS}
      initialRows={proposedRows(chainId, list.blocks)}
      initialNext={list.blocks.length >= VALIDATOR_PAGE && last ? String(last.height) : null}
      accent={accent}
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
          v: `${voteOptionLabel(v.option)}${v.weighted ? ", split" : ""}${
            recasts?.get(v.proposalId)
              ? `, was ${recasts.get(v.proposalId)!.map(voteOptionLabel).join(", ")}`
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
        { v: "-", dim: true },
        { v: "-", dim: true, align: "right" as const },
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
        v: e.amounts.length > 0 ? e.amounts.map((a) => coin(a)).join(", ") : "-",
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

export async function PowerEventsTab({ chain, accent, addr }: ValidatorKeys) {
  const chainId = chain.chainId;
  const { coin } = coinFormatter(chain);
  const power = await loadPowerEvents(chainId, addr);
  if (!power) return <NotAvailable />;
  const flow = (net: string | null) => {
    if (net === null) return null;
    const neg = net.startsWith("-");
    const abs = neg ? net.slice(1) : net;
    return `${neg ? "−" : abs === "0" ? "" : "+"}${coin({ denom: chain.denom, amount: abs })}`;
  };
  const flow7 = flow(power.flow7);
  const flow30 = flow(power.flow30);
  const last = power.events.at(-1);
  return (
    <OlderDeck
      endpoint={`/${chainId}/validators/${addr}/power`}
      columns={POWER_COLUMNS}
      initialRows={powerRows(chain, addr, power.events)}
      initialNext={power.events.length >= VALIDATOR_PAGE && last ? String(last.height) : null}
      accent={accent}
      empty="None"
      extra={
        flow7 || flow30 ? (
          <>
            {flow7 ? <Fact label="net 7d" value={flow7} /> : null}
            {flow30 ? <Fact label="net 30d" value={flow30} /> : null}
          </>
        ) : undefined
      }
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
  return "-";
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
    // Only unjails that went through: a failed MsgUnjail left the validator
    // jailed (the audit found 20 such rows, 15 of them FIVETECH's).
    ...(events ?? [])
      .filter((e) => e.kind === "unjail" && e.ok)
      .filter(
        (u) => !slashes.events.some((e) => e.kind === "unjailed" && e.height === u.height)
      )
      .map((e) => ({
        height: e.height,
        time: e.time,
        label: "Unjailed",
        reason: "-",
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
        if (!spell) return { v: "-", dim: true, align: "right" as const };
        return spell.unjailedAt
          ? { v: formatDuration(spell.downtimeMs), mono: true, align: "right" as const }
          : // Open only while the chain still says jailed; otherwise the unjail
            // predates what the index holds.
            jailedOnChain
            ? { v: "ongoing", tone: "bad" as const, align: "right" as const }
            : { v: "-", dim: true, align: "right" as const };
      })(),
      {
        v: e.burned ? coin({ denom: chain.denom, amount: e.burned }) : "-",
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
