"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";
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
 * Every figure the page has is a column, every column sorts, and a row goes
 * straight to the validator's own page. Active and inactive validators are two
 * views of the same list, switched above it.
 *
 * The table never scrolls sideways. Every column but the validator's name has
 * a fixed width and a breakpoint below which it is not drawn; the name takes
 * whatever is left and truncates. The breakpoints are chosen so the name keeps
 * at least ~16rem at every width. Any column whose data this chain does not
 * provide is not drawn at all.
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
  const shown = bars;
  return (
    <div className="flex h-[10px] w-full items-end gap-px">
      {shown.map((signed, i) => (
        <span
          key={i}
          className="h-full flex-1 rounded-[1px]"
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
/** One wording everywhere: Active, Unbonding, Inactive (Jailed is shown apart). */
function statusLabel(status: string): string {
  const s = status.replace("BOND_STATUS_", "").toUpperCase();
  if (s === "BONDED" || s === "ACTIVE" || s === "") return "Active";
  if (s === "UNBONDING") return "Unbonding";
  if (s === "UNBONDED" || s === "INACTIVE") return "Inactive";
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/** The data part of a bech32 address, past its prefix — the part that differs. */
function addressTail(address: string): string {
  const data = address.slice(address.lastIndexOf("1") + 1);
  return data.length > 14 ? `${data.slice(0, 7)}…${data.slice(-6)}` : data;
}

interface Column {
  key: string;
  label: string;
  sort?: SortKey;
  align?: "right";
  /** Fixed width; absent only for the name, which takes the rest. */
  w?: string;
  /** Tailwind visibility for the header and cells, e.g. "hidden md:table-cell". */
  show?: string;
  title?: string;
  cell: (v: ValidatorRow) => React.ReactNode;
}

export function ValidatorsTable({
  chainId,
  accent,
  rows,
  inactiveRows = [],
  symbol,
  staking,
  hasUptime,
  jailingsSince = null,
  chainApr = null,
}: {
  /** Chain staking APR before commission, 0–1; each row nets its own commission. */
  chainApr?: number | null;
  chainId: string;
  accent: string;
  rows: ValidatorRow[];
  /** Unbonding and unbonded validators, shown when the selector says so. */
  inactiveRows?: ValidatorRow[];
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
  const [set, setSet] = useState<"active" | "inactive">("active");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "rank",
    dir: "asc",
  });

  const source = set === "active" ? rows : inactiveRows;

  const visible = useMemo(
    // Sorted before filtering so ranks stay the chain's, not the filtered list's.
    () => filterValidators(sortValidators(source, sort.key, sort.dir), query),
    [source, sort, query]
  );

  function onSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] }
    );
  }

  // A column is drawn only where at least one row in view has something for it.
  const hasDelta = source.some((r) => r.delta?.ratio != null);
  const hasSelfBond = source.some((r) => r.selfBond?.share != null);
  const hasJailings = source.some((r) => r.jailings !== null);
  const hasSigning = hasUptime && source.some((r) => r.uptime.ratio !== null);
  const hasBars = hasUptime && source.some((r) => r.uptime.bars.length > 0);
  const barCount = Math.max(0, ...source.map((r) => r.uptime.bars.length));
  const hasMissed = hasUptime && source.some((r) => r.uptime.missed !== null);

  const columns: Column[] = [
    {
      key: "rank",
      label: "#",
      sort: "rank",
      align: "right",
      w: "2.75rem",
      cell: (v) => <span className="text-muted-foreground">{v.rank}</span>,
    },
    {
      key: "moniker",
      label: "Validator",
      sort: "moniker",
      cell: (v) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-sans text-[13px] font-medium text-foreground transition-colors group-hover/row:text-[var(--gata-blue)]">
            {v.moniker}
          </span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {addressTail(v.operatorAddress)}
          </span>
        </span>
      ),
    },
    {
      key: "tokens",
      label: staking ? "Stake" : "Power",
      title: staking ? `Staked ${symbol}` : "Consensus voting power",
      sort: "tokens",
      align: "right",
      w: "6.5rem",
      cell: (v) => <span style={{ color: ink(accent) }}>{v.tokensLabel}</span>,
    },
    {
      key: "share",
      label: "Share",
      sort: "tokens",
      align: "right",
      w: "5rem",
      show: "hidden sm:table-cell",
      cell: (v) => pct(v.votingPower),
    },
    {
      key: "cumulative",
      label: "Cumul.",
      title: "Share held by this validator and everyone ranked above it",
      align: "right",
      w: "5.5rem",
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
            w: "5rem",
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
            label: "Self",
            title: "The operator's own share of its stake",
            sort: "selfBond" as const,
            align: "right" as const,
            w: "5rem",
            show: "hidden xl:table-cell",
            cell: (v: ValidatorRow) => pct(v.selfBond?.share ?? null),
          },
        ]
      : []),
    ...(staking
      ? [
          {
            key: "commission",
            label: "Comm.",
            title: "Commission",
            sort: "commission" as const,
            align: "right" as const,
            w: "5rem",
            show: "hidden sm:table-cell",
            cell: (v: ValidatorRow) => pct(v.commissionRate),
          },
        ]
      : []),
    ...(staking && chainApr !== null
      ? [
          {
            key: "apr",
            label: "APR",
            title: "Expected APR after commission",
            align: "right" as const,
            w: "5rem",
            show: "hidden lg:table-cell",
            cell: (v: ValidatorRow) => pct(chainApr * (1 - v.commissionRate)),
          },
        ]
      : []),
    ...(hasSigning
      ? [
          {
            key: "uptime",
            label: "Uptime",
            sort: "uptime" as const,
            align: "right" as const,
            w: "5.5rem",
            show: "hidden md:table-cell",
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
        ]
      : []),
    ...(hasBars
      ? [
          {
            key: "signing",
            label: `Last ${barCount}`,
            title: `Last ${barCount} blocks, newest on the right`,
            w: "7rem",
            show: "hidden lg:table-cell",
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
            w: "4.5rem",
            show: "hidden xl:table-cell",
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
            w: "5.5rem",
            show: "hidden xl:table-cell",
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
      w: "5.75rem",
      cell: (v) =>
        v.jailed ? (
          <span className="inline-flex rounded-full bg-[var(--destructive)]/12 px-2 py-0.5 font-sans text-[11px] font-medium text-[var(--destructive)]">
            Jailed
          </span>
        ) : (
          <span
            className={`inline-flex rounded-full px-2 py-0.5 font-sans text-[11px] font-medium ${
              set === "active"
                ? "bg-[var(--gata-green)]/12 text-[var(--gata-green)]"
                : "bg-[var(--gata-faint)]/15 text-muted-foreground"
            }`}
          >
            {statusLabel(v.status)}
          </span>
        ),
    },
  ];

  const href = (v: ValidatorRow) => `/${chainId}/validators/${v.operatorAddress}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-2.5">
        {/* Active or inactive: two views of one list. */}
        <div
          role="tablist"
          aria-label="Validator set"
          className="inline-flex shrink-0 rounded-lg border border-border bg-[var(--gata-card)] p-0.5"
        >
          {(
            [
              ["active", "Active", rows.length],
              ["inactive", "Inactive", inactiveRows.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={set === key}
              onClick={() => setSet(key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                set === key
                  ? "bg-[var(--gata-card-hi)] text-foreground shadow-[inset_0_0_0_1px_var(--gata-border-hi)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {count}
              </span>
            </button>
          ))}
        </div>

        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or address…"
            aria-label="Filter validators"
            spellCheck={false}
            className="h-8 w-full rounded-lg border border-border bg-[var(--gata-card)] pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[var(--gata-border-hi)]"
          />
        </div>

        {query ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {visible.length} of {source.length}
          </span>
        ) : null}
      </div>

      <div className="gata-surface min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <table className="w-full table-fixed border-collapse">
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
                    style={c.w ? { width: c.w } : undefined}
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
              <th aria-hidden="true" style={{ width: "1.75rem" }} />
            </tr>
          </thead>
          <tbody>
            {visible.map((v) => (
              <tr
                key={v.operatorAddress}
                onClick={() => router.push(href(v))}
                className={`group/row cursor-pointer border-b border-border/40 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)] ${
                  v.jailed ? "bg-[var(--destructive)]/[0.05]" : ""
                }`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`h-[42px] overflow-hidden text-ellipsis whitespace-nowrap px-2.5 font-mono text-[12.5px] tabular-nums ${
                      c.align === "right" ? "text-right" : ""
                    } ${c.show ?? ""}`}
                  >
                    {c.key === "moniker" ? (
                      // A real link inside the row, so the page is reachable by
                      // keyboard and opens in a new tab like any other link.
                      <Link
                        href={href(v)}
                        prefetch={false}
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
                <td aria-hidden="true" className="pr-2 text-right">
                  <ChevronRight className="ml-auto h-3.5 w-3.5 text-[var(--gata-faint)] transition-[color,transform] group-hover/row:translate-x-0.5 group-hover/row:text-foreground" />
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="h-24 text-center text-[13px] text-muted-foreground"
                >
                  {query
                    ? `No validator matches "${query}".`
                    : set === "inactive"
                      ? "No inactive validators"
                      : "No validators"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
