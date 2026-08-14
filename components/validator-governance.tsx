import type { ChainConfig } from "@/lib/chains";
import { accentFor } from "@/lib/chains";
import { governanceParticipation } from "@/lib/indexer-db";
import { voteOptionLabel } from "@/lib/proposals";
import { timeAgo } from "@/lib/format";

/**
 * How this validator votes on governance.
 *
 * The one thing about a validator that neither its stake nor its uptime can
 * tell you: whether it turns up. A validator carries its delegators' voting
 * power by default, so an operator that never votes is deciding by absence.
 *
 * Reads the indexed votes. The gov module deletes votes from state once a
 * proposal tallies, so for anything already decided this is the only lasting
 * record — the node cannot answer this at all, which is why the section is
 * absent rather than empty on chains we do not index.
 *
 * Keyed on the validator's own account, since that is what casts the vote.
 */
export async function ValidatorGovernance({
  chain,
  account,
}: {
  chain: ChainConfig;
  /** The validator's self-delegation account, not its operator address. */
  account: string | null;
}) {
  if (!account) return null;

  const stats = await governanceParticipation(chain.chainId, account).catch(
    () => null
  );
  if (!stats || stats.total === 0) return null;

  const accent = accentFor(chain);
  const share = stats.voted / stats.total;

  return (
    <>
      <h2 className="mt-6 mb-3 text-sm font-medium text-muted-foreground">
        Governance
      </h2>
      <div
        className="gata-panel px-5 py-4"
        style={{ ["--panel-accent" as string]: accent }}
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Participation
            </dt>
            <dd className="mt-1.5 font-mono text-lg font-semibold leading-none">
              {(share * 100).toFixed(0)}%
            </dd>
            <p className="mt-1 text-xs text-muted-foreground">
              {stats.voted} of {stats.total}
            </p>
          </div>
          {stats.byOption.slice(0, 3).map((o) => (
            <div key={o.option}>
              <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {voteOptionLabel(o.option)}
              </dt>
              <dd className="mt-1.5 font-mono text-lg font-semibold leading-none">
                {o.count}
              </dd>
            </div>
          ))}
        </dl>

        {stats.lastVote ? (
          <p className="mt-4 text-xs text-muted-foreground">
            last voted {timeAgo(stats.lastVote)}
          </p>
        ) : null}
      </div>
    </>
  );
}
