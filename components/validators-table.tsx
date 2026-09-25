"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search } from "lucide-react";
import {
  filterValidators,
  sortValidators,
  type SortKey,
  type ValidatorRow,
} from "@/lib/validator-sort";
import { jailRecord } from "@/lib/format";
import { ink } from "@/lib/utils";

export type { ValidatorRow, SortKey } from "@/lib/validator-sort";

/**
 * The validator set as a list, with a column for everything worth comparing.
 *
 * It was a wall of tiles carrying four facts each, with the rest in a popup
 * per validator. Comparing validators is the point of this page, and you
 * cannot compare what is hidden behind a click, so every figure the page has
 * is now a column, every column sorts, and a row goes straight to the
 * validator's own page.
 *
 * Columns drop out narrowest-first as the screen shrinks, and any column whose
 * data this chain does not provide is not drawn at all. The list scrolls inside
 * its frame; the page does not.
 */

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

const pct = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`;

/**
 * Signing history at row height. Newest on the right; a missed block is a
 * full-height mark in a contrasting colour, because the gaps are the point.
 */
function MiniBars({ bars }: { bars: boolean[] }) {
  const shown = bars.slice(-24);
  return (
    <div className="flex h-[10px] w-full max-w-[6rem] items-end gap-px">
      {shown.map((signed, i) => (
        <span
          key={i}
          className="h-full flex-1"
          style={{
            background: signed ? "var(--gata-green)" : "var(--destructive)",
            opacity: signed ? 0.55 : 1,
          }}
        />
      ))}
    </div>
  );
}

/** "BOND_STATUS_BONDED" and "ACTIVE" both read as one capitalised word. */
function statusLabel(status: string): string {
  const s = status.replace("BOND_STATUS_", "").toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Active";
}

interface Column {
  key: string;
  label: string;
  sort?: SortKey;
  align?: "right";
  /** Tailwind visibility for the header and cells, e.g. "hidden md:table-cell". */
  show?: string;
  title?: string;
  cell: (v: ValidatorRow) => React.ReactNode;
}

export function ValidatorsTable({
  chainId,
  accent,
  rows,
  symbol,
  staking,
  hasUptime,
  jailingsSince = null,
}: {
  chainId: string;
  accent: string;
  rows: ValidatorRow[];
  symbol: string;
  /** Chains with no staking module rank by assigned consensus weight. */
  staking: boolean;
  hasUptime: boolean;
  /**
   * Start of the window the jailing counts cover, already formatted. Null means
   * the index reaches the first block, so the window is the chain's whole life.
   */
  jailingsSince?: string | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "rank",
    dir: "asc",
  });

  const visible = useMemo(
    // Sorted before filtering so ranks stay the chain's, not the filtered list's.
    () => filterValidators(sortValidators(rows, sort.key, sort.dir), query),
    [rows, sort, query]
  );

  function onSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] }
    );
  }

  // A column is drawn only where at least one row has something to put in it.
  const hasDelta = rows.some((r) => r.delta?.ratio != null);
  const hasSelfBond = rows.some((r) => r.selfBond?.share != null);
  const hasJailings = rows.some((r) => r.jailings !== null);
  const hasMissed = hasUptime && rows.some((r) => r.uptime.missed !== null);

  const columns: Column[] = [
    {
      key: "rank",
      label: "#",
      sort: "rank",
      align: "right",
      cell: (v) => <span className="text-muted-foreground">{v.rank}</span>,
    },
    {
      key: "moniker",
      label: "Validator",
      sort: "moniker",
      cell: (v) => (
        <span className="flex min-w-0 max-w-[8.5rem] flex-col sm:max-w-[16rem]">
          <span className="truncate font-sans text-[13px] font-medium">{v.moniker}</span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {v.operatorAddress.slice(0, 12)}…{v.operatorAddress.slice(-5)}
          </span>
        </span>
      ),
    },
    {
      key: "tokens",
      label: staking ? `Stake` : "Power",
      title: staking ? `Staked ${symbol}` : "Consensus voting power",
      sort: "tokens",
      align: "right",
      cell: (v) => <span style={{ color: ink(accent) }}>{v.tokensLabel}</span>,
    },
    {
      key: "share",
      label: "Share",
      sort: "tokens",
      align: "right",
      show: "hidden sm:table-cell",
      cell: (v) => pct(v.votingPower),
    },
    {
      key: "cumulative",
      label: "Cumulative",
      title: "Share held by this validator and everyone ranked above it",
      align: "right",
      show: "hidden xl:table-cell",
      cell: (v) => (
        <span className={v.cumulativePower > 1 / 3 ? "text-muted-foreground" : undefined}>
          {pct(v.cumulativePower, 1)}
        </span>
      ),
    },
    ...(hasDelta
      ? [
          {
            key: "delta",
            label: "24h",
            title: "Change in stake over the last 24 hours",
            sort: "delta" as const,
            align: "right" as const,
            show: "hidden lg:table-cell",
            cell: (v: ValidatorRow) => {
              const r = v.delta?.ratio;
              if (r == null) return <span className="text-muted-foreground">—</span>;
              if (r === 0) return <span className="text-muted-foreground">0.00%</span>;
              return (
                <span className={r > 0 ? "text-[var(--gata-green)]" : "text-[var(--gata-burn)]"}>
                  {r > 0 ? "+" : ""}
                  {(r * 100).toFixed(2)}%
                </span>
              );
            },
          },
        ]
      : []),
    ...(hasSelfBond
      ? [
          {
            key: "selfBond",
            label: "Self bond",
            title: "The operator's own share of its stake",
            sort: "selfBond" as const,
            align: "right" as const,
            show: "hidden xl:table-cell",
            cell: (v: ValidatorRow) => pct(v.selfBond?.share ?? null),
          },
        ]
      : []),
    ...(staking
      ? [
          {
            key: "commission",
            label: "Commission",
            sort: "commission" as const,
            align: "right" as const,
            show: "hidden sm:table-cell",
            cell: (v: ValidatorRow) => pct(v.commissionRate),
          },
        ]
      : []),
    ...(hasUptime
      ? [
          {
            key: "uptime",
            label: "Uptime",
            sort: "uptime" as const,
            align: "right" as const,
            show: "hidden sm:table-cell",
            cell: (v: ValidatorRow) => (
              <span
                className={
                  v.uptime.ratio !== null && v.uptime.ratio < 0.99
                    ? "text-[var(--gata-amber)]"
                    : undefined
                }
              >
                {pct(v.uptime.ratio)}
              </span>
            ),
          },
          {
            key: "signing",
            label: "Recent blocks",
            title: "Last 24 blocks, newest on the right",
            show: "hidden md:table-cell",
            cell: (v: ValidatorRow) =>
              v.uptime.bars.length > 0 ? (
                <MiniBars bars={v.uptime.bars} />
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
        ]
      : []),
    ...(hasMissed
      ? [
          {
            key: "missed",
            label: "Missed",
            title: "Blocks missed in the signing window",
            align: "right" as const,
            show: "hidden lg:table-cell",
            cell: (v: ValidatorRow) =>
              v.uptime.missed === null ? "—" : v.uptime.missed.toLocaleString(),
          },
        ]
      : []),
    ...(hasJailings
      ? [
          {
            key: "jailings",
            label: "Jailed",
            title: `Times jailed since ${jailingsSince ?? "genesis"}`,
            sort: "jailings" as const,
            align: "right" as const,
            show: "hidden lg:table-cell",
            cell: (v: ValidatorRow) => {
              const text = jailRecord(v.jailings);
              return (
                <span
                  className={
                    text === "Never" || text === "—"
                      ? "text-muted-foreground"
                      : "text-[var(--gata-burn)]"
                  }
                >
                  {text}
                </span>
              );
            },
          },
        ]
      : []),
    {
      key: "status",
      label: "Status",
      align: "right",
      cell: (v) =>
        v.jailed ? (
          <span className="text-[var(--destructive)]">Jailed</span>
        ) : (
          <span className="text-[var(--gata-green)]">{statusLabel(v.status)}</span>
        ),
    },
  ];

  const href = (v: ValidatorRow) => `/${chainId}/validators/${v.operatorAddress}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 pb-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or address…"
            aria-label="Filter validators"
            spellCheck={false}
            className="h-8 w-full rounded-lg border border-border bg-secondary/50 pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[var(--gata-border-hi)]"
          />
        </div>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {visible.length}
          {visible.length !== rows.length ? ` of ${rows.length}` : ""} validators
        </span>
      </div>

      <div className="gata-surface min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse whitespace-nowrap">
          <thead className="sticky top-0 z-10 bg-[var(--gata-bg2)]">
            <tr className="border-b border-border">
              {columns.map((c) => {
                // Share sorts by stake too; only the stake column shows the arrow.
                const active = c.sort === sort.key && c.key !== "share";
                return (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.title}
                    aria-sort={
                      active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
                    }
                    className={`h-8 px-2.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground ${
                      c.align === "right" ? "text-right" : "text-left"
                    } ${c.show ?? ""}`}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        onClick={() => onSort(c.sort!)}
                        className={`uppercase tracking-[0.1em] transition-colors hover:text-foreground ${
                          active ? "text-foreground" : ""
                        }`}
                      >
                        {c.label}
                        {active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((v) => (
              <tr
                key={v.operatorAddress}
                onClick={() => router.push(href(v))}
                className={`cursor-pointer border-b border-border/40 last:border-0 hover:bg-[var(--gata-card-hi)] ${
                  v.jailed ? "bg-[var(--destructive)]/[0.06]" : ""
                }`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`relative h-[42px] px-2.5 font-mono text-[12.5px] tabular-nums ${
                      c.align === "right" ? "text-right" : ""
                    } ${c.show ?? ""}`}
                  >
                    {c.key === "moniker" ? (
                      // A real link inside the row, so the page is reachable by
                      // keyboard and opens in a new tab like any other link.
                      <Link
                        href={href(v)}
                        onClick={(e) => e.stopPropagation()}
                        className="block min-w-0 outline-none focus-visible:underline"
                      >
                        {c.cell(v)}
                      </Link>
                    ) : (
                      c.cell(v)
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="h-24 text-center text-[13px] text-muted-foreground"
                >
                  {query ? `No validator matches "${query}".` : "No validators."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
