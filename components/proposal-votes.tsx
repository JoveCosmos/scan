import Link from "next/link";
import type { ChainConfig } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { voteOptionLabel, isVoting } from "@/lib/proposals";
import { truncateMiddle } from "@/lib/format";

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

export async function ProposalVotes({
  chain,
  proposalId,
  status,
}: {
  chain: ChainConfig;
  proposalId: string;
  status: string;
}) {
  const { votes, total, byOption, source, truncated, failed } = await getAdapter(
    chain
  ).getProposalVotes(proposalId);

  if (votes.length === 0) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {failed
            ? // Never claim there are no votes when we simply could not read them.
              "Could not load votes right now — the node did not respond."
            : isVoting(status)
              ? "No votes cast yet."
              : "No votes found for this proposal, in state or in transaction history."}
        </p>
      </div>
    );
  }

  const shown = votes.length;
  const counted = total ?? shown;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {Object.entries(byOption)
          .sort((a, b) => b[1] - a[1])
          .map(([option, count]) => (
            <span key={option} className="inline-flex items-center gap-1.5">
              <OptionBadge option={option} />
              <span className="font-mono tabular-nums">{count}</span>
            </span>
          ))}
        <span className="ml-auto">by voter count, not stake</span>
      </div>

      {source === "history" ? (
        <p className="mb-3 text-xs text-muted-foreground">
          The gov module deletes votes from state when it tallies a proposal, so
          these are reconstructed from the vote transactions in block history —
          the last vote recorded per address.
        </p>
      ) : null}

      <div className="gata-panel overflow-x-auto">
        <table className="gata-table w-full text-sm sm:min-w-[420px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">Voter</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Vote</th>
            </tr>
          </thead>
          <tbody>
            {votes.map((vote) => (
              <tr
                key={vote.voter}
                className="border-b border-border/50 last:border-0 hover:bg-[var(--gata-card-hi)]/60"
              >
                <td data-label="Voter" data-primary className="px-4 py-3">
                  <Link
                    href={`/${chain.chainId}/accounts/${vote.voter}`}
                    className="-my-2 inline-block py-2 font-mono text-xs text-primary hover:underline"
                    title={vote.voter}
                  >
                    {truncateMiddle(vote.voter, 14, 8)}
                  </Link>
                </td>
                <td data-label="Vote" className="px-4 py-3">
                  {vote.weighted ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      {vote.options.map((o) => (
                        <span key={o.option} className="inline-flex items-center gap-1">
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

      {truncated || counted > shown ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing {shown.toLocaleString()}
          {counted > shown ? ` of ${counted.toLocaleString()}` : " of more"} votes.
        </p>
      ) : null}
    </>
  );
}
