import type { ChainConfig } from "@/lib/chains";
import { accentFor, chainDenoms } from "@/lib/chains";
import { commissionEarned } from "@/lib/indexer-db";
import { formatToken } from "@/lib/overview";
import { shortDenom } from "@/lib/coin";
import { timeAgo } from "@/lib/format";

/**
 * What the commission rate actually produced.
 *
 * Every explorer shows the rate. None show the outcome, because the chain does
 * not keep it: the distribution module carries only what is currently
 * outstanding, so the moment commission is withdrawn the amount survives
 * nowhere but in the block events. Reading it back is the whole argument for
 * indexing.
 *
 * Read alongside self bond it says something a rate cannot: an operator with a
 * token of its own at stake that has taken six figures in commission is a
 * different proposition from one that has taken nothing.
 */
export async function ValidatorCommission({
  chain,
  operator,
}: {
  chain: ChainConfig;
  operator: string;
}) {
  const earned = await commissionEarned(chain.chainId, operator).catch(() => null);
  if (!earned) return null;

  const accent = accentFor(chain);
  // The chain's own denoms carry a symbol and an exponent; anything else (an
  // IBC hash) is shown as-is rather than scaled by a guess.
  const known = new Map(chainDenoms(chain).map((d) => [d.denom, d]));

  return (
    <>
      <h2 className="mt-6 mb-3 text-sm font-medium text-muted-foreground">
        Commission taken
      </h2>
      <div
        className="gata-panel px-5 py-4"
        style={{ ["--panel-accent" as string]: accent }}
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {earned.byDenom.slice(0, 2).map((d) => {
            const info = known.get(d.denom);
            return (
              <div key={d.denom}>
                <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {info ? info.symbol : shortDenom(d.denom)}
                </dt>
                <dd className="mt-1.5 font-mono text-lg font-semibold leading-none">
                  {info ? formatToken(d.amount, info.exponent, 2) : d.amount}
                </dd>
              </div>
            );
          })}
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Withdrawals
            </dt>
            <dd className="mt-1.5 font-mono text-lg font-semibold leading-none">
              {earned.withdrawals.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Last
            </dt>
            <dd className="mt-1.5 font-mono text-lg font-semibold leading-none">
              {earned.last ? timeAgo(earned.last) : "-"}
            </dd>
          </div>
        </dl>

        {/* Withdrawn, not earned: what is still accruing sits in Outstanding
            Commission above, and the two together are the lifetime figure. */}
        <p className="mt-4 text-xs text-muted-foreground">
          withdrawn since {earned.first ? new Date(earned.first).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          }) : "genesis"}
        </p>
      </div>
    </>
  );
}
