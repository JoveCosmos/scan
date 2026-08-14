import type { ChainConfig } from "@/lib/chains";
import { accentFor, chainDenoms } from "@/lib/chains";
import { commissionEarned } from "@/lib/indexer-db";
import { formatToken } from "@/lib/overview";
import { shortDenom } from "@/lib/coin";
import { timeAgo } from "@/lib/format";
import { StatRail } from "@/components/stat-rail";

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
  account,
}: {
  chain: ChainConfig;
  /** The validator's own account — see commissionEarned for why, not operator. */
  account: string | null;
}) {
  if (!account) return null;
  const earned = await commissionEarned(chain.chainId, account).catch(() => null);
  if (!earned) return null;

  const accent = accentFor(chain);
  // The chain's own denoms carry a symbol and an exponent; anything else (an
  // IBC hash) is shown as-is rather than scaled by a guess.
  const known = new Map(chainDenoms(chain).map((d) => [d.denom, d]));

  return (
    <>
      <h2 className="mt-5 mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Commission taken
      </h2>
      <StatRail
        accent={accent}
        note={`withdrawn since ${
          earned.first
            ? new Date(earned.first).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : "genesis"
        }`}
        stats={[
          ...earned.byDenom.slice(0, 2).map((d) => {
            const info = known.get(d.denom);
            return {
              label: info ? info.symbol : shortDenom(d.denom),
              value: info ? formatToken(d.amount, info.exponent, 2) : d.amount,
            };
          }),
          { label: "Withdrawals", value: earned.withdrawals.toLocaleString() },
          { label: "Last", value: earned.last ? timeAgo(earned.last) : "-" },
        ]}
      />
    </>
  );
}
