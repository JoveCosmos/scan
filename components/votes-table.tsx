"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
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
  const [shown, setShown] = useState(PAGE);

  const validatorVotes = useMemo(() => votes.filter((v) => v.validator), [votes]);
  const active = tab === "validators" ? validatorVotes : votes;
  const visible = active.slice(0, shown);

  const select = (next: "all" | "validators") => {
    setTab(next);
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

      {active.length === 0 ? (
        <div className="gata-panel px-5 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            No validator in the active set voted on this proposal.
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
