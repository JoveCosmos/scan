"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
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
}

export type SortKey =
  | "rank"
  | "moniker"
  | "tokens"
  | "delta"
  | "commission"
  | "uptime"
  | "jailed";

/** Ascending by default for names; everything numeric reads better biggest-first. */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  rank: "asc",
  moniker: "asc",
  tokens: "desc",
  delta: "desc",
  commission: "asc",
  uptime: "desc",
  jailed: "desc",
};

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
  }
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
  slashingWindow,
  exponent,
}: {
  chainId: string;
  rows: ValidatorRow[];
  accent: string;
  staking: boolean;
  hasDeltas: boolean;
  slashingWindow: boolean;
  exponent: number;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "rank",
    dir: "asc",
  });

  const sorted = useMemo(
    () => sortValidators(rows, sort.key, sort.dir),
    [rows, sort]
  );

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
    <div className="gata-panel overflow-x-auto">
      <table className="gata-table w-full text-sm sm:min-w-[860px]">
        <thead>
          <tr className="border-b border-border text-left">
            {header("#", "rank")}
            {header("Validator", "moniker")}
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Voting Power
            </th>
            {staking ? (
              <>
                {header("Staked", "tokens", "right")}
                {hasDeltas ? header("24h", "delta", "right") : null}
                {header("Commission", "commission", "right")}
              </>
            ) : (
              header("Power", "tokens", "right")
            )}
            {header("Uptime", "uptime", "right")}
            {slashingWindow ? header("Last Jailed", "jailed", "right") : null}
            <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => (
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
              <td data-label="Voting Power" className="px-4 py-2.5 text-right">
                <div className="font-mono tabular-nums">
                  {(v.votingPower * 100).toFixed(2)}%
                </div>
                <div
                  className="mt-1 ml-auto h-1 w-20 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (v.votingPower / topPower) * 100)}%`,
                      background: accent,
                    }}
                  />
                </div>
              </td>
              {!staking ? (
                <td
                  data-label="Power"
                  className="px-4 py-2.5 text-right font-mono tabular-nums"
                >
                  {Number(v.tokens).toLocaleString()}
                </td>
              ) : (
                <>
                  <td
                    data-label="Staked"
                    className="px-4 py-2.5 text-right font-mono tabular-nums"
                  >
                    {v.tokensLabel}
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
              <td data-label="Uptime" className="px-4 py-2.5 text-right">
                <UptimeBars
                  uptime={v.uptime}
                  slashingWindow={slashingWindow}
                  className="items-end"
                />
              </td>
              {slashingWindow ? (
                <td data-label="Last Jailed" className="px-4 py-2.5 text-right">
                  <LastJailed uptime={v.uptime} />
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
    </div>
  );
}
