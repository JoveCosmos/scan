"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  filterValidators,
  sortValidators,
  type SortKey,
  type ValidatorRow,
} from "@/lib/validator-sort";
import { RowDeck, type DeckColumn, type DeckRow } from "@/components/row-deck";

export type { ValidatorRow, SortKey } from "@/lib/validator-sort";

/**
 * The validator set.
 *
 * Presentation only — the ranking and filtering live in `lib/validator-sort.ts`,
 * where they can be tested without a renderer. What is left here is the choice
 * of what to show in a row and what to keep for the popup, which is the whole
 * design: nine columns did not fit a phone and never fitted a fixed-height
 * page, so a row carries the four figures you compare validators by and the
 * popup carries everything you check about one of them.
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

export function ValidatorsTable({
  chainId,
  accent,
  rows,
  symbol,
  staking,
  hasUptime,
}: {
  chainId: string;
  accent: string;
  rows: ValidatorRow[];
  symbol: string;
  /** Chains with no staking module rank by assigned consensus weight. */
  staking: boolean;
  hasUptime: boolean;
  /** Accepted and ignored: the deck has no 24h column, the popup has the row. */
  hasDeltas?: boolean;
  slashingWindow?: boolean;
  grossApr?: number | null;
  exponent?: number;
  jailingsSince?: string | null;
}) {
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

  function onSort(key: string) {
    const k = key as SortKey;
    setSort((s) =>
      s.key === k
        ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: k, dir: DEFAULT_DIR[k] }
    );
  }

  const columns: DeckColumn[] = [
    { label: "#", align: "right", width: "8%", sortKey: "rank" },
    { label: "Validator", sortKey: "moniker" },
    {
      label: staking ? "Staked" : "Power",
      align: "right",
      width: "18%",
      sortKey: "tokens",
    },
    { label: "Share", align: "right", width: "12%", phoneHide: true },
    ...(staking
      ? [
          {
            label: "Comm",
            align: "right" as const,
            width: "12%",
            optional: true,
            sortKey: "commission",
          },
        ]
      : []),
    ...(hasUptime
      ? [
          {
            label: "Uptime",
            align: "right" as const,
            width: "13%",
            optional: true,
            sortKey: "uptime",
          },
        ]
      : []),
    { label: "Status", width: "14%", phoneHide: true, sortKey: "jailed" },
  ];

  const deckRows: DeckRow[] = visible.map((v) => {
    // `ratio` is already the signed share; null means the window could not be
    // read at all, which is a different claim from a low ratio.
    const uptimeRatio = v.uptime.ratio;

    return {
      key: v.operatorAddress,
      cells: [
        { v: String(v.rank), dim: true, align: "right" },
        { v: v.moniker, tone: "accent" },
        { v: v.tokensLabel, mono: true, align: "right", bar: v.votingPower },
        { v: pct(v.votingPower), mono: true, dim: true, align: "right" },
        ...(staking
          ? [
              {
                v: pct(v.commissionRate, 1),
                mono: true,
                dim: true,
                align: "right" as const,
              },
            ]
          : []),
        ...(hasUptime
          ? [
              {
                v: pct(uptimeRatio, 1),
                mono: true,
                align: "right" as const,
                tone:
                  uptimeRatio === null
                    ? undefined
                    : uptimeRatio >= 0.99
                      ? ("ok" as const)
                      : uptimeRatio < 0.95
                        ? ("bad" as const)
                        : undefined,
              },
            ]
          : []),
        {
          v: v.jailed ? "jailed" : "active",
          mono: true,
          tone: v.jailed ? "bad" : "ok",
        },
      ],
      detail: {
        title: v.moniker,
        sub: `Rank #${v.rank}`,
        rows: [
          { label: "Operator", value: v.operatorAddress, mono: true },
          {
            label: staking ? "Staked" : "Voting power",
            value: `${v.tokensLabel} ${symbol}`,
            mono: true,
          },
          { label: "Share of stake", value: pct(v.votingPower), mono: true },
          ...(v.selfBond
            ? [
                {
                  label: "Self bond",
                  value:
                    v.selfBond.share !== null
                      ? `${pct(v.selfBond.share)} of its own stake`
                      : v.selfBond.amount,
                  mono: true,
                },
              ]
            : []),
          ...(v.delta?.ratio !== null && v.delta !== null
            ? [
                {
                  label: "24h change",
                  // `change` is a bigint of base denom; `ratio` is the signed
                  // fraction, which is the comparable figure.
                  value: `${v.delta.ratio! >= 0 ? "+" : ""}${(v.delta.ratio! * 100).toFixed(2)}%`,
                  mono: true,
                },
              ]
            : []),
          ...(staking
            ? [{ label: "Commission", value: pct(v.commissionRate), mono: true }]
            : []),
          ...(hasUptime && v.uptime.window
            ? [
                {
                  label: "Uptime",
                  value: `${pct(v.uptime.ratio)} of ${v.uptime.window.toLocaleString()} blocks`,
                  mono: true,
                },
                ...(v.uptime.missed !== null
                  ? [
                      {
                        label: "Missed",
                        value: v.uptime.missed.toLocaleString(),
                        mono: true,
                      },
                    ]
                  : []),
              ]
            : []),
          {
            label: "Status",
            value: v.jailed
              ? "Jailed"
              : v.status.replace("BOND_STATUS_", "").toLowerCase(),
          },
          ...(v.jailings
            ? [
                {
                  label: "Jailed before",
                  value: v.jailings.tombstoned
                    ? "Tombstoned"
                    : `${v.jailings.count} time${v.jailings.count === 1 ? "" : "s"} in the indexed window`,
                },
              ]
            : []),
        ],
        action: {
          label: "Full validator profile",
          href: `/${chainId}/validators/${v.operatorAddress}`,
        },
      },
    };
  });

  return (
    <RowDeck
      accent={accent}
      columns={columns}
      rows={deckRows}
      sort={sort}
      onSort={onSort}
      empty={query ? `No validator matches "${query}".` : "No validators."}
      toolbar={
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or address…"
            aria-label="Filter validators"
            spellCheck={false}
            className="h-8 w-full rounded-lg border border-border bg-secondary/50 pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[var(--gata-border-hi)] sm:max-w-xs"
          />
        </div>
      }
    />
  );
}
