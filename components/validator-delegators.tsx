import Link from "next/link";
import type { ChainConfig } from "@/lib/chains";
import { symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";

/**
 * Delegators, largest first. Streamed separately — a validator with thousands of
 * delegators makes this the slowest read on the page, and nothing above it
 * depends on the result.
 */
export async function ValidatorDelegators({
  chain,
  operatorAddress,
}: {
  chain: ChainConfig;
  operatorAddress: string;
}) {
  const { delegators, total, failed } = await getAdapter(chain).getDelegators(
    operatorAddress
  );
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  if (failed) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Could not load delegators — the node did not respond. Several public
          endpoints disable this query on validators with very large sets.
        </p>
      </div>
    );
  }

  if (delegators.length === 0) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">No delegations found.</p>
      </div>
    );
  }

  return (
    <>
      <div className="gata-panel overflow-x-auto">
        <table className="gata-table w-full text-sm sm:min-w-[520px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">#</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Delegator</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Amount
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {delegators.map((d, i) => (
              <tr
                key={d.address}
                className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
              >
                <td
                  data-label="Rank"
                  className="px-4 py-3 font-mono tabular-nums text-muted-foreground"
                >
                  {i + 1}
                </td>
                <td data-label="Delegator" data-primary className="px-4 py-3">
                  <Link
                    href={`/${chain.chainId}/accounts/${d.address}`}
                    className="-my-2 inline-block py-2 font-mono text-xs text-primary hover:underline"
                    title={d.address}
                  >
                    {truncateMiddle(d.address, 14, 8)}
                  </Link>
                </td>
                <td
                  data-label="Amount"
                  className="px-4 py-3 text-right font-mono tabular-nums"
                >
                  {formatToken(d.amount, chain.exponent, 2)}{" "}
                  <span className="text-muted-foreground">{symbol}</span>
                </td>
                <td data-label="Share" className="px-4 py-3 text-right">
                  <div className="font-mono text-xs tabular-nums">
                    {(d.share * 100).toFixed(2)}%
                  </div>
                  <div
                    className="mt-1 ml-auto h-1 w-16 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (d.share / (delegators[0]?.share || 1)) * 100)}%`,
                        background: accent,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {total !== null && total > delegators.length
          ? `Showing the ${delegators.length} largest of ${total.toLocaleString()} delegators.`
          : `Showing the ${delegators.length} largest delegations.`}
      </p>
    </>
  );
}
