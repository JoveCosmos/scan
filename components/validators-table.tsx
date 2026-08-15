"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, ChevronDown, ChevronUp } from "lucide-react";
import type { ValidatorUptime } from "@/lib/uptime";
import type { StakeDelta } from "@/lib/stake-delta";
import { UptimeBars } from "@/components/uptime-bars";
import { ValidatorStatus } from "@/components/validator-status";
import { StakeChange } from "@/components/stake-change";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ValidatorRow {
  rank: number;
  operatorAddress: string;
  moniker: string;
  votingPower: number;
  /** Base denom, as a string — a large validator's stake exceeds a safe double. */
  tokens: string;
  /** Pre-formatted by the server, which owns the chain's exponent. */
  tokensLabel: string;
  commissionRate: number;
  jailed: boolean;
  status: string;
  uptime: ValidatorUptime;
  delta: StakeDelta | null;
  /**
   * Times jailed within the indexed window, or null when the indexer cannot
   * say. Null and zero are different claims: zero means "never, in the window
   * shown", null means the column has no basis at all.
   */
  jailings: { count: number; tombstoned: boolean } | null;
  /** The validator's own stake, or null when the query did not answer. */
  selfBond: { amount: string; share: number | null } | null;
}

export type SortKey =
  | "rank"
  | "moniker"
  | "tokens"
  | "selfBond"
  | "delta"
  | "commission"
  | "uptime"
  | "jailed"
  | "jailings";

/** Ascending by default for names; everything numeric reads better biggest-first. */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  rank: "asc",
  moniker: "asc",
  tokens: "desc",
  selfBond: "desc",
  delta: "desc",
  commission: "asc",
  uptime: "desc",
  jailed: "desc",
  jailings: "desc",
};

/**
 * Exported for tests, like the sort below.
 *
 * Applied after sorting, so ranks stay the chain's rather than the filtered
 * list's. Matches the operator address as well as the moniker: pasting an
 * address in is how you find a validator you know by address, and it costs
 * nothing to support.
 */
export function filterValidators(rows: ValidatorRow[], query: string): ValidatorRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (v) =>
      v.moniker.toLowerCase().includes(q) ||
      v.operatorAddress.toLowerCase().includes(q)
  );
}

/** Exported for tests: the sort is the substantive logic in this component. */
export function sortValidators(
  rows: ValidatorRow[],
  key: SortKey,
  dir: "asc" | "desc"
): ValidatorRow[] {
  const copy = [...rows];
  copy.sort((a, b) => (dir === "asc" ? compare(a, b, key) : -compare(a, b, key)));
  return copy;
}

function compare(a: ValidatorRow, b: ValidatorRow, key: SortKey): number {
  switch (key) {
    case "rank":
      return a.rank - b.rank;
    case "moniker":
      return a.moniker.localeCompare(b.moniker, undefined, { sensitivity: "base" });
    case "tokens": {
      // BigInt: stake exceeds what a double compares exactly.
      const x = BigInt(a.tokens);
      const y = BigInt(b.tokens);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "selfBond": {
      // Sorted by share, not amount: the question is how much of its own stake
      // an operator has behind the delegations, which a raw total cannot say.
      const x = a.selfBond?.share ?? -1;
      const y = b.selfBond?.share ?? -1;
      return x - y;
    }
    case "delta": {
      // Unknown deltas sink to the bottom either way rather than posing as zero.
      if (!a.delta && !b.delta) return 0;
      if (!a.delta) return -1;
      if (!b.delta) return 1;
      return a.delta.change < b.delta.change
        ? -1
        : a.delta.change > b.delta.change
          ? 1
          : 0;
    }
    case "commission":
      return a.commissionRate - b.commissionRate;
    case "uptime": {
      const x = a.uptime.ratio;
      const y = b.uptime.ratio;
      if (x === null && y === null) return 0;
      if (x === null) return -1;
      if (y === null) return 1;
      return x - y;
    }
    case "jailed": {
      // Never-jailed sorts as the oldest possible date, so "most recently
      // jailed" surfaces first on a descending sort.
      const x = a.uptime.jailedUntil ? Date.parse(a.uptime.jailedUntil) : 0;
      const y = b.uptime.jailedUntil ? Date.parse(b.uptime.jailedUntil) : 0;
      return x - y;
    }
    case "jailings": {
      // Unknown sorts below zero: a validator we have no history for should not
      // outrank one we know was never jailed.
      const x = a.jailings ? a.jailings.count : -1;
      const y = b.jailings ? b.jailings.count : -1;
      return x - y;
    }
  }
}

/**
 * An amount, its share small beneath, and a bar.
 *
 * Used by both Staked and Self Bond, which were each two facts crammed into one
 * cell. The amount is what you read; the bar is what you compare.
 *
 * `fill` is deliberately separate from `share`, because the two columns scale
 * differently and both are right to. Voting power is a share of the whole set,
 * so the largest validator holds maybe 7% and drawing that against 100% leaves
 * every bar flat against zero — it is scaled to the biggest instead. Self bond
 * is a share of the validator's *own* stake, where 85% and 1% are directly
 * meaningful and a bar that is nearly empty is the correct picture of an
 * operator with nothing at risk.
 */
function FigureWithBar({
  amount,
  share,
  fill,
  accent,
}: {
  amount: string;
  /** Printed above the bar. */
  share: number | null;
  /** Bar width, 0–1. */
  fill: number;
  accent: string;
}) {
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <span className="font-mono tabular-nums">{amount}</span>
      <span className="flex w-16 flex-col items-end gap-0.5">
        <span className="font-mono text-[10px] leading-none text-muted-foreground">
          {share === null ? "-" : `${(share * 100).toFixed(2)}%`}
        </span>
        <span
          className="h-1 w-full overflow-hidden rounded-full bg-foreground/15"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${Math.max(0, Math.min(100, fill * 100))}%`,
              background: accent,
            }}
          />
        </span>
      </span>
    </div>
  );
}

function SelfBond({
  selfBond,
  exponent,
}: {
  selfBond: ValidatorRow["selfBond"];
  exponent: number;
}) {
  if (!selfBond) return <span className="text-xs text-muted-foreground">-</span>;

  return (
    <FigureWithBar
      amount={formatAmount(selfBond.amount, exponent)}
      share={selfBond.share}
      // Absolute, not scaled to the biggest self bonder — see FigureWithBar.
      fill={selfBond.share ?? 0}
      // Deliberately not the chain accent: that belongs to stake, and one colour
      // across both columns read as a single bar broken by a border.
      accent="var(--gata-sub)"
    />
  );
}

/** Compact token amount. The table's other amounts are pre-formatted server
 *  side, but self bond arrives raw. */
function formatAmount(raw: string, exponent: number): string {
  const n = Number(raw) / 10 ** exponent;
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

/**
 * Jail history in one cell: how many times, and when last.
 *
 * They were two columns, which only worked when both had data. The count comes
 * from indexed block events and the date from the slashing module, so on a chain
 * we do not index the count column was a row of dashes next to a real date. Here
 * the count leads when we have it, the date sits under it, and neither claims
 * more than it knows.
 */
function Jailed({
  uptime,
  jailings,
}: {
  uptime: ValidatorUptime;
  jailings: ValidatorRow["jailings"];
}) {
  const until = uptime.jailedUntil ? new Date(uptime.jailedUntil) : null;
  const stillJailed = until ? until.getTime() > Date.now() : false;
  const date = until
    ? until.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  if (jailings?.tombstoned) {
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <span className="text-xs font-medium text-[var(--gata-burn)]">
          Tombstoned
        </span>
        {date ? (
          <span className="font-mono text-[11px] text-muted-foreground">{date}</span>
        ) : null}
      </span>
    );
  }

  // Never jailed, and nothing counted against it either.
  if (!date && (jailings === null || jailings.count === 0)) {
    return <span className="text-xs text-muted-foreground">Never</span>;
  }

  return (
    <span className="inline-flex flex-col items-end leading-tight">
      {jailings !== null ? (
        <span
          className={
            jailings.count > 0
              ? "font-mono text-sm tabular-nums text-[var(--gata-burn)]"
              : "text-xs text-muted-foreground"
          }
        >
          {jailings.count > 0 ? `${jailings.count}×` : "Never"}
        </span>
      ) : null}
      {date ? (
        <span
          className={
            stillJailed
              ? "font-mono text-[11px] text-[var(--gata-burn)]"
              : "font-mono text-[11px] text-muted-foreground"
          }
          title={
            stillJailed
              ? `Jailed until ${until!.toLocaleString()}`
              : `Released ${until!.toLocaleString()}`
          }
        >
          {stillJailed ? `until ${date}` : date}
        </span>
      ) : null}
    </span>
  );
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground",
        align === "right" ? "text-right" : "text-left"
      )}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          active && "text-foreground"
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : null}
      </button>
    </th>
  );
}

export function ValidatorsTable({
  chainId,
  rows,
  accent,
  staking,
  hasDeltas,
  hasUptime,
  grossApr,
  slashingWindow,
  exponent,
  jailingsSince,
}: {
  chainId: string;
  rows: ValidatorRow[];
  accent: string;
  staking: boolean;
  hasDeltas: boolean;
  /** False when the tier does not gather uptime, so the columns are dropped
   *  rather than rendered empty for every validator. */
  hasUptime: boolean;
  /**
   * Chain-wide staking APR before commission, or null when it cannot be
   * derived. Deliberately not a column of its own: per-validator APR is this
   * figure times (1 − commission), so a column would rank identically to
   * commission and say the same thing twice. It goes under the rate, because
   * "5%" does not tell a delegator what they earn and "14.87%" does.
   */
  grossApr: number | null;
  slashingWindow: boolean;
  exponent: number;
  /**
   * Start of the indexed window the jailing counts came from, or null when the
   * indexer has nothing to say — in which case the column is not shown at all.
   */
  /** Null when the counts cover the whole chain and need no qualifying. */
  jailingsSince: string | null;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "rank",
    dir: "asc",
  });
  const [query, setQuery] = useState("");

  const sorted = useMemo(
    () => sortValidators(rows, sort.key, sort.dir),
    [rows, sort]
  );

  const visible = useMemo(() => filterValidators(sorted, query), [sorted, query]);

  const onSort = (key: SortKey) => {
    setSort((prev) =>
      // Re-clicking the active column flips it; a new column starts in whichever
      // direction is actually useful for that kind of value.
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] }
    );
  };

  const header = (label: string, key: SortKey, align?: "left" | "right") => (
    <SortHeader
      label={label}
      sortKey={key}
      active={sort.key === key}
      dir={sort.dir}
      onSort={onSort}
      align={align}
    />
  );

  const topPower = rows[0]?.votingPower || 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or address…"
            aria-label="Filter validators"
            className="w-full rounded-lg border border-border bg-secondary/50 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[var(--gata-border-hi)] focus:bg-secondary"
          />
        </div>
        {query ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {visible.length} of {rows.length}
          </span>
        ) : null}
      </div>

      <div className="gata-panel overflow-x-auto">
      <table className="gata-table w-full text-sm sm:min-w-[860px]">
        <thead>
          <tr className="border-b border-border text-left">
            {header("#", "rank")}
            {header("Validator", "moniker")}
            {staking ? (
              <>
                {header("Self Bond", "selfBond", "right")}
                {header("Staked", "tokens", "right")}
                {hasDeltas ? header("24h", "delta", "right") : null}
                {header("Commission", "commission", "right")}
              </>
            ) : (
              header("Power", "tokens", "right")
            )}
            {hasUptime && slashingWindow
              ? header("Jailed", jailingsSince ? "jailings" : "jailed", "right")
              : null}
            {hasUptime ? header("Uptime", "uptime", "right") : null}
            <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((v) => (
            <tr
              key={v.operatorAddress}
              className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
            >
              <td
                data-label="Rank"
                className="px-4 py-2 font-mono tabular-nums text-muted-foreground"
              >
                {v.rank}
              </td>
              <td
                data-label="Validator"
                data-primary
                className="px-4 py-2 sm:max-w-[240px]"
              >
                <Link
                  href={`/${chainId}/validators/${v.operatorAddress}`}
                  className="block min-w-0"
                >
                  <div
                    className="truncate font-medium text-primary hover:underline"
                    title={v.moniker}
                  >
                    {v.moniker}
                  </div>
                  <div
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={v.operatorAddress}
                  >
                    {truncateMiddle(v.operatorAddress, 14, 8)}
                  </div>
                </Link>
              </td>
              {!staking ? (
                <td
                  data-label="Power"
                  className="px-4 py-2 text-right"
                >
                  <FigureWithBar
                    amount={Number(v.tokens).toLocaleString()}
                    share={v.votingPower}
                    fill={v.votingPower / topPower}
                    accent={accent}
                  />
                </td>
              ) : (
                <>
                  <td
                    data-label="Self Bond"
                    className="px-4 py-2 text-right font-mono tabular-nums"
                  >
                    <SelfBond selfBond={v.selfBond} exponent={exponent} />
                  </td>
                  <td data-label="Staked" className="px-4 py-2 text-right">
                    <FigureWithBar
                      amount={v.tokensLabel}
                      share={v.votingPower}
                      fill={v.votingPower / topPower}
                      accent={accent}
                    />
                  </td>
                  {hasDeltas ? (
                    <td data-label="24h" className="px-4 py-2 text-right">
                      <StakeChange delta={v.delta ?? undefined} exponent={exponent} />
                    </td>
                  ) : null}
                  <td
                    data-label="Commission"
                    className="px-4 py-2 text-right font-mono tabular-nums"
                  >
                    <span className="inline-flex flex-col items-end leading-tight">
                      <span>{(v.commissionRate * 100).toFixed(1)}%</span>
                      {grossApr !== null ? (
                        <span className="text-[11px] text-muted-foreground">
                          {(grossApr * (1 - v.commissionRate) * 100).toFixed(2)}% APR
                        </span>
                      ) : null}
                    </span>
                  </td>
                </>
              )}
              {hasUptime && slashingWindow ? (
                <td data-label="Jailed" className="px-4 py-2 text-right">
                  <Jailed uptime={v.uptime} jailings={v.jailings} />
                </td>
              ) : null}
              {hasUptime ? (
                <td data-label="Uptime" className="px-4 py-2 text-right">
                  <UptimeBars
                    uptime={v.uptime}
                    slashingWindow={slashingWindow}
                    className="items-end"
                  />
                </td>
              ) : null}
              <td data-label="Status" className="px-4 py-2">
                <ValidatorStatus
                  jailed={v.jailed}
                  status={v.status}
                  tombstoned={v.uptime.tombstoned}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {visible.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          No validator matches “{query}”.
        </p>
      ) : null}

      {/* Only while the index is partial. Where it holds every block, "0" means
          never, and dating that to the chain's own start says less than nothing. */}
      {jailingsSince ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          Jail counts since{" "}
          {new Date(jailingsSince).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </p>
      ) : null}
      </div>
    </div>
  );
}
