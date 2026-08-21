"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import {
  filterValidators,
  sortValidators,
  type SortKey,
  type ValidatorRow,
} from "@/lib/validator-sort";
import { Popup, PopupRows } from "@/components/ui/popup";

export type { ValidatorRow, SortKey } from "@/lib/validator-sort";

/**
 * The validator set as a wall of tiles rather than a paged table.
 *
 * A hundred validators is a set you want to see the shape of — who is large,
 * who is missing blocks, how the tail falls away. A table showed twenty at a
 * time and made you page through five screens to get an impression that a
 * single screen can give directly. Paging a ranked list is also the worst case
 * for paging: rank 47 is only meaningful next to 46 and 48.
 *
 * So a tile carries exactly the four things you compare validators by — rank,
 * name, stake and whether it has been signing — and nothing else. Everything
 * you check about *one* validator is a click away, which is the same bargain
 * the rest of the app makes.
 *
 * The tiles are sized so a full active set fits a desktop screen. Where it does
 * not — a phone, or a chain with a larger set — the wall scrolls rather than
 * paginating, because scrolling a grid keeps neighbours adjacent and paging
 * does not.
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

const SORTS: { key: SortKey; label: string }[] = [
  { key: "rank", label: "Rank" },
  { key: "moniker", label: "Name" },
  { key: "tokens", label: "Stake" },
  { key: "uptime", label: "Uptime" },
  { key: "commission", label: "Commission" },
];

const pct = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`;

/**
 * Signing history at tile size.
 *
 * Twenty-four bars, newest on the right. At this scale a missed block has to be
 * a full-height mark in a contrasting colour to register at all — a shade of
 * the same colour would disappear, and the one thing this strip exists to show
 * is the gaps.
 */
function MiniBars({ bars, ratio }: { bars: boolean[]; ratio: number | null }) {
  if (bars.length === 0) {
    // No per-block history: fall back to the ratio as a single meter, which is
    // a weaker claim and should look like one.
    return (
      <div className="h-[3px] w-full bg-[var(--gata-border)]">
        {ratio !== null ? (
          <div
            className="h-full"
            style={{
              width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
              background: ratio >= 0.99 ? "var(--gata-green)" : "var(--gata-amber)",
            }}
          />
        ) : null}
      </div>
    );
  }

  const shown = bars.slice(-24);
  return (
    <div className="flex h-[7px] w-full items-end gap-px">
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
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "rank",
    dir: "asc",
  });
  const [openKey, setOpenKey] = useState<string | null>(null);

  const visible = useMemo(
    // Sorted before filtering so ranks stay the chain's, not the filtered list's.
    () => filterValidators(sortValidators(rows, sort.key, sort.dir), query),
    [rows, sort, query]
  );

  const open = rows.find((v) => v.operatorAddress === openKey) ?? null;

  function onSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] }
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative sm:max-w-xs sm:flex-1">
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

        <div className="flex items-center gap-1 overflow-x-auto text-[11px] text-muted-foreground">
          <span className="shrink-0 pr-1">Sort</span>
          {SORTS.filter((s) => (staking || s.key !== "commission") && (hasUptime || s.key !== "uptime")).map(
            (s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => onSort(s.key)}
                aria-pressed={sort.key === s.key}
                className={`shrink-0 rounded-md px-1.5 py-1 transition-colors hover:text-foreground ${
                  sort.key === s.key
                    ? "bg-[var(--gata-card-hi)] text-foreground"
                    : ""
                }`}
              >
                {s.label}
                {sort.key === s.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
              </button>
            )
          )}
          <span className="shrink-0 pl-1 font-mono tabular-nums">
            {visible.length}
            {visible.length !== rows.length ? `/${rows.length}` : ""}
          </span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] content-start gap-1 overflow-y-auto">
        {visible.map((v) => (
          <button
            key={v.operatorAddress}
            type="button"
            onClick={() => setOpenKey(v.operatorAddress)}
            title={v.moniker}
            className={`flex h-[3.4rem] flex-col justify-between overflow-hidden border px-2 py-1.5 text-left transition-colors hover:border-[var(--gata-border-hi)] hover:bg-[var(--gata-card-hi)] ${
              v.jailed
                ? "border-[var(--destructive)]/40 bg-[var(--destructive)]/[0.06]"
                : "border-border bg-[var(--gata-card)]"
            }`}
          >
            <span className="flex items-baseline gap-1.5 overflow-hidden">
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {v.rank}
              </span>
              <span className="truncate text-[12px] font-medium leading-none">
                {v.moniker}
              </span>
            </span>

            <span className="truncate font-mono text-[12px] leading-none" style={{ color: accent }}>
              {v.tokensLabel}
            </span>

            {hasUptime ? (
              <MiniBars bars={v.uptime.bars} ratio={v.uptime.ratio} />
            ) : (
              <span className="text-[10px] leading-none text-muted-foreground">
                {pct(v.votingPower)}
              </span>
            )}
          </button>
        ))}

        {visible.length === 0 ? (
          <p className="col-span-full py-8 text-center text-[13px] text-muted-foreground">
            {query ? `No validator matches "${query}".` : "No validators."}
          </p>
        ) : null}
      </div>

      <Popup
        open={open !== null}
        onClose={() => setOpenKey(null)}
        title={open?.moniker ?? ""}
        sub={open ? `Rank #${open.rank}` : undefined}
        accent={accent}
      >
        {open ? (
          <>
            {hasUptime && open.uptime.bars.length > 0 ? (
              <div className="mb-3">
                <MiniBars bars={open.uptime.bars} ratio={open.uptime.ratio} />
              </div>
            ) : null}
            <PopupRows
              rows={[
                { label: "Operator", value: open.operatorAddress, mono: true },
                {
                  label: staking ? "Staked" : "Voting power",
                  value: `${open.tokensLabel} ${symbol}`,
                  mono: true,
                },
                { label: "Share of stake", value: pct(open.votingPower), mono: true },
                ...(open.selfBond
                  ? [
                      {
                        label: "Self bond",
                        value:
                          open.selfBond.share !== null
                            ? `${pct(open.selfBond.share)} of its own stake`
                            : open.selfBond.amount,
                        mono: true,
                      },
                    ]
                  : []),
                ...(open.delta?.ratio != null
                  ? [
                      {
                        label: "24h change",
                        value: `${open.delta.ratio >= 0 ? "+" : ""}${(open.delta.ratio * 100).toFixed(2)}%`,
                        mono: true,
                      },
                    ]
                  : []),
                ...(staking
                  ? [
                      {
                        label: "Commission",
                        value: pct(open.commissionRate),
                        mono: true,
                      },
                    ]
                  : []),
                ...(hasUptime && open.uptime.window
                  ? [
                      {
                        label: "Uptime",
                        value: `${pct(open.uptime.ratio)} of ${open.uptime.window.toLocaleString()} blocks`,
                        mono: true,
                      },
                      ...(open.uptime.missed !== null
                        ? [
                            {
                              label: "Missed",
                              value: open.uptime.missed.toLocaleString(),
                              mono: true,
                            },
                          ]
                        : []),
                    ]
                  : []),
                {
                  label: "Status",
                  value: open.jailed
                    ? "Jailed"
                    : open.status.replace("BOND_STATUS_", "").toLowerCase(),
                },
                ...(open.jailings
                  ? [
                      {
                        label: "Jailed before",
                        value: open.jailings.tombstoned
                          ? "Tombstoned"
                          : `${open.jailings.count} time${open.jailings.count === 1 ? "" : "s"} in the indexed window`,
                      },
                    ]
                  : []),
              ]}
            />
            <Link
              href={`/${chainId}/validators/${open.operatorAddress}`}
              onClick={() => setOpenKey(null)}
              className="mt-4 inline-flex text-sm text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
            >
              Full validator profile →
            </Link>
          </>
        ) : null}
      </Popup>
    </div>
  );
}
