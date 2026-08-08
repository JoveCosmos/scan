import type { ChainConfig } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { voteOptionLabel, isVoting, indexValidatorAccounts } from "@/lib/proposals";
import { VotesTable, type VoteRow } from "@/components/votes-table";

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
  const adapter = getAdapter(chain);
  // Fetched together: the validator set is already cached from the validators
  // page, and the join is what lets votes be filtered to the active set.
  const [{ votes, byOption, source, truncated, failed }, validators] =
    await Promise.all([
      adapter.getProposalVotes(proposalId),
      adapter.getValidators().catch(() => []),
    ]);

  const byAccount = indexValidatorAccounts(validators, chain.bech32Prefix);

  const rows: VoteRow[] = votes.map((vote) => ({
    ...vote,
    validator: byAccount.get(vote.voter) ?? null,
  }));

  if (votes.length === 0) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {failed
            ? // Never claim there are no votes when we simply could not read them.
              "Could not load votes right now - the node did not respond."
            : isVoting(status)
              ? "No votes cast yet."
              : "No votes found for this proposal, in state or in transaction history."}
        </p>
      </div>
    );
  }

  const shown = votes.length;

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

      <VotesTable chainId={chain.chainId} votes={rows} />

      {truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          More votes exist than could be read in one request; the list above is
          capped at {shown.toLocaleString()}.
        </p>
      ) : null}
    </>
  );
}
