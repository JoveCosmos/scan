"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/utils";

// Duplicated from lib/proposals rather than imported: that module reaches the
// LCD layer, and pulling a server data module into the client bundle stops this
// component hydrating at all. A four-entry label map is the cheaper dependency.
const VOTE_LABEL: Record<string, string> = {
  VOTE_OPTION_YES: "Yes",
  VOTE_OPTION_NO: "No",
  VOTE_OPTION_NO_WITH_VETO: "No with Veto",
  VOTE_OPTION_ABSTAIN: "Abstain",
  VOTE_OPTION_UNSPECIFIED: "Unspecified",
};

function voteOptionLabel(option: string): string {
  return VOTE_LABEL[option] ?? option.replace(/^VOTE_OPTION_/, "");
}

/** A vote, plus the validator identity behind it when the voter is one. */
export interface VoteRow {
  voter: string;
  options: { option: string; weight: number }[];
  primary: string;
  weighted: boolean;
  validator: { moniker: string; operatorAddress: string } | null;
}

/**
 * Votes matching a free-text query, by either identity a voter is known by:
 * the moniker for validators, the address for everyone else.
 *
 * Matched against the full address rather than the truncated form shown in the
 * table, so a pasted address still finds its row.
 */
export function filterVotes(votes: VoteRow[], query: string): VoteRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return votes;
  return votes.filter(
    (v) =>
      v.voter.toLowerCase().includes(q) ||
      (v.validator?.moniker.toLowerCase().includes(q) ?? false)
  );
}

const OPTION_STYLE: Record<string, string> = {
  VOTE_OPTION_YES: "bg-[var(--gata-green)]/12 text-[var(--gata-green)]",
  VOTE_OPTION_NO: "bg-[var(--gata-burn)]/12 text-[var(--gata-burn)]",
  VOTE_OPTION_NO_WITH_VETO: "bg-[var(--gata-amber)]/12 text-[var(--gata-amber)]",
  VOTE_OPTION_ABSTAIN: "bg-secondary text-muted-foreground",
};

function OptionBadge({ option }: { option: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        OPTION_STYLE[option] ?? "bg-secondary text-muted-foreground"
      }`}
    >
      {voteOptionLabel(option)}
    </span>
  );
}

/** Rows revealed per "show more" press. Turnout runs to thousands, and mounting
 *  every row at once is what makes a long vote list feel slow. */
const PAGE = 100;

export function VotesTable({
  chainId,
  votes,
}: {
  chainId: string;
  votes: VoteRow[];
}) {
  const [tab, setTab] = useState<"all" | "validators">("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const validatorVotes = useMemo(() => votes.filter((v) => v.validator), [votes]);
  const inTab = tab === "validators" ? validatorVotes : votes;

  const active = useMemo(() => filterVotes(inTab, query), [inTab, query]);

  const visible = active.slice(0, shown);

  const select = (next: "all" | "validators") => {
    setTab(next);
    setShown(PAGE);
  };

  const search = (next: string) => {
    setQuery(next);
    // A new query should start from the top, not keep a deep scroll position.
    setShown(PAGE);
  };

  const TABS = [
    { key: "all" as const, label: "All votes", count: votes.length },
    {
      key: "validators" as const,
      label: "Validators",
      count: validatorVotes.length,
    },
  ];

  return (
    <>
      <div
        role="tablist"
        aria-label="Vote filter"
        className="mb-3 flex items-center gap-1 border-b border-border"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => select(t.key)}
            className={cn(
              "relative whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors",
              tab === t.key
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            <span className="ml-1.5 font-mono text-xs tabular-nums text-muted-foreground">
              {t.count.toLocaleString()}
            </span>
            {tab === t.key ? (
              <span className="absolute inset-x-3 -bottom-px h-px bg-primary shadow-[0_0_8px_var(--gata-glow)]" />
            ) : null}
          </button>
        ))}
      </div>

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder={
            tab === "validators"
              ? "Filter by validator name…"
              : "Filter by validator name or voter address…"
          }
          aria-label="Filter votes"
          className="w-full rounded-lg border border-border bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
        />
      </div>

      {active.length === 0 ? (
        <div className="gata-panel px-5 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {query.trim()
              ? `No vote matches “${query.trim()}”.`
              : "No validator in the active set voted on this proposal."}
          </p>
        </div>
      ) : (
        <>
          <div className="gata-panel overflow-x-auto">
            <table className="gata-table w-full text-sm sm:min-w-[420px]">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Voter
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Vote
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((vote) => (
                  <tr
                    key={vote.voter}
                    className="border-b border-border/50 last:border-0 hover:bg-[var(--gata-card-hi)]/60"
                  >
                    <td data-label="Voter" data-primary className="px-4 py-3">
                      {vote.validator ? (
                        <Link
                          href={`/${chainId}/validators/${vote.validator.operatorAddress}`}
                          className="-my-2 inline-block py-2 text-primary hover:underline"
                          title={vote.voter}
                        >
                          {vote.validator.moniker}
                        </Link>
                      ) : (
                        <Link
                          href={`/${chainId}/accounts/${vote.voter}`}
                          className="-my-2 inline-block py-2 font-mono text-xs text-primary hover:underline"
                          title={vote.voter}
                        >
                          {truncateMiddle(vote.voter, 14, 8)}
                        </Link>
                      )}
                    </td>
                    <td data-label="Vote" className="px-4 py-3">
                      {vote.weighted ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          {vote.options.map((o) => (
                            <span
                              key={o.option}
                              className="inline-flex items-center gap-1"
                            >
                              <OptionBadge option={o.option} />
                              <span className="font-mono text-xs text-muted-foreground">
                                {(o.weight * 100).toFixed(0)}%
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <OptionBadge option={vote.primary} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {query.trim() && visible.length === active.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {active.length.toLocaleString()} of {inTab.length.toLocaleString()}{" "}
              {tab === "validators" ? "validator votes" : "votes"} match.
            </p>
          ) : null}

          {visible.length < active.length ? (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="mt-3 w-full rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-[var(--gata-card-hi)]/60 hover:text-foreground"
            >
              Show more — {visible.length.toLocaleString()} of{" "}
              {active.length.toLocaleString()}
            </button>
          ) : null}
        </>
      )}
    </>
  );
}
