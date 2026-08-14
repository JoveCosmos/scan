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
 * Stake, with voting power as a bar beneath it.
 *
 * They were two columns saying one thing: a validator's share of stake *is* its
 * voting power, so the percentage only ever restated the amount beside it.
 * Merged, the amount is the figure and the bar is the comparison — the width is
 * relative to the largest validator, which is what makes the top of the set
 * legible at a glance rather than every bar sitting near zero.
 */
function Staked({
  amount,
  share,
  relative,
  accent,
}: {
  amount: string;
  share: number;
  relative: number;
  accent: string;
}) {
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <span className="font-mono tabular-nums">{amount}</span>
      <span className="flex w-20 flex-col items-end gap-0.5">
        <span className="font-mono text-[10px] leading-none text-muted-foreground">
          {(share * 100).toFixed(2)}%
        </span>
        <span
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${Math.min(100, relative * 100)}%`,
              background: accent,
            }}
          />
        </span>
      </span>
    </div>
  );
}

/**
 * Share first, amount second. "3.43M ATONE" means nothing without the stake it
 * sits against; 85% versus 0.00% is the whole point of the column.
 */
function SelfBond({
  selfBond,
  exponent,
}: {
  selfBond: ValidatorRow["selfBond"];
  exponent: number;
}) {
  if (!selfBond) return <span className="text-xs text-muted-foreground">-</span>;

  const share = selfBond.share;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className={share !== null && share < 0.001 ? "text-muted-foreground" : undefined}>
        {share === null ? "-" : `${(share * 100).toFixed(2)}%`}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {formatAmount(selfBond.amount, exponent)}
      </span>
    </span>
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

function Jailings({ jailings }: { jailings: ValidatorRow["jailings"] }) {
  if (!jailings) return <span className="text-xs text-muted-foreground">-</span>;

  if (jailings.tombstoned) {
    return (
      <span className="text-xs font-medium text-[var(--gata-burn)]">
        Tombstoned
      </span>
    );
  }

  if (jailings.count === 0) {
    return <span className="text-xs text-muted-foreground">0</span>;
  }

  return (
    <span className="tabular-nums text-[var(--gata-burn)]">
      {jailings.count}
    </span>
  );
}

function LastJailed({ uptime }: { uptime: ValidatorUptime }) {
  if (!uptime.jailedUntil) {
    return <span className="text-xs text-muted-foreground">Never</span>;
  }

  const until = new Date(uptime.jailedUntil);
  const stillJailed = until.getTime() > Date.now();
  const label = until.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        stillJailed ? "text-[var(--gata-burn)]" : "text-muted-foreground"
      )}
      title={
        stillJailed
          ? `Jailed until ${until.toLocaleString()}`
          : `Released from jail ${until.toLocaleString()}`
      }
    >
      {stillJailed ? `until ${label}` : label}
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
        "px-4 py-3 font-medium text-muted-foreground",
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
  slashingWindow: boolean;
  exponent: number;
  /**
   * Start of the indexed window the jailing counts came from, or null when the
   * indexer has nothing to say — in which case the column is not shown at all.
   */
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
                {header("Staked", "tokens", "right")}
                {header("Self Bond", "selfBond", "right")}
                {hasDeltas ? header("24h", "delta", "right") : null}
                {header("Commission", "commission", "right")}
              </>
            ) : (
              header("Power", "tokens", "right")
            )}
            {hasUptime && slashingWindow
              ? header("Last Jailed", "jailed", "right")
              : null}
            {jailingsSince ? header("Jailed", "jailings", "right") : null}
            {hasUptime ? header("Uptime", "uptime", "right") : null}
            <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
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
                className="px-4 py-2.5 font-mono tabular-nums text-muted-foreground"
              >
                {v.rank}
              </td>
              <td
                data-label="Validator"
                data-primary
                className="px-4 py-2.5 sm:max-w-[240px]"
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
                  className="px-4 py-2.5 text-right"
                >
                  <Staked
                    amount={Number(v.tokens).toLocaleString()}
                    share={v.votingPower}
                    relative={v.votingPower / topPower}
                    accent={accent}
                  />
                </td>
              ) : (
                <>
                  <td data-label="Staked" className="px-4 py-2.5 text-right">
                    <Staked
                      amount={v.tokensLabel}
                      share={v.votingPower}
                      relative={v.votingPower / topPower}
                      accent={accent}
                    />
                  </td>
                  <td
                    data-label="Self Bond"
                    className="px-4 py-2.5 text-right font-mono tabular-nums"
                  >
                    <SelfBond selfBond={v.selfBond} exponent={exponent} />
                  </td>
                  {hasDeltas ? (
                    <td data-label="24h" className="px-4 py-2.5 text-right">
                      <StakeChange delta={v.delta ?? undefined} exponent={exponent} />
                    </td>
                  ) : null}
                  <td
                    data-label="Commission"
                    className="px-4 py-2.5 text-right font-mono tabular-nums"
                  >
                    {(v.commissionRate * 100).toFixed(1)}%
                  </td>
                </>
              )}
              {hasUptime && slashingWindow ? (
                <td data-label="Last Jailed" className="px-4 py-2.5 text-right">
                  <LastJailed uptime={v.uptime} />
                </td>
              ) : null}
              {jailingsSince ? (
                <td data-label="Jailed" className="px-4 py-2.5 text-right">
                  <Jailings jailings={v.jailings} />
                </td>
              ) : null}
              {hasUptime ? (
                <td data-label="Uptime" className="px-4 py-2.5 text-right">
                  <UptimeBars
                    uptime={v.uptime}
                    slashingWindow={slashingWindow}
                    className="items-end"
                  />
                </td>
              ) : null}
              <td data-label="Status" className="px-4 py-2.5">
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

      {jailingsSince ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          Jailed counts how many times each validator has been jailed since{" "}
          {new Date(jailingsSince).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
          , from indexed block events. The chain keeps only the most recent jail
          date, shown under Last Jailed.
        </p>
      ) : null}
      </div>
    </div>
  );
}
