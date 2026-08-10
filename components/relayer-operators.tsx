import Link from "next/link";
import type { ChainConfig } from "@/lib/chains";
import { symbolForDenom, accentFor } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { truncateMiddle, timeAgo } from "@/lib/format";
import { relayerStats } from "@/lib/indexer-db";
import { RELAYER_MSG_TYPES } from "@/lib/relayers";

/**
 * The operators keeping this chain's channels alive, ranked by work done.
 *
 * Renders an explanation rather than nothing when the chain is not indexed:
 * an empty operator table would read as "nobody relays here", which is the
 * opposite of the truth on any chain with open channels.
 */
export async function RelayerOperators({ chain }: { chain: ChainConfig }) {
  const stats = await relayerStats(chain.chainId, RELAYER_MSG_TYPES);
  const accent = accentFor(chain);

  if (!stats) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Operator statistics need indexed transaction history, which we do not
          have for {chain.prettyName} yet.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Relaying leaves no trace in chain state - a delivered packet looks the
          same whoever delivered it - so this can only be counted from
          transactions, and nodes forget those beyond their pruning window.
        </p>
      </div>
    );
  }

  if (stats.operators.length === 0) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No relay transactions in the indexed range.
        </p>
      </div>
    );
  }

  // Fees are paid in the fee token where a chain has a separate one — AtomOne
  // charges PHOTON, and labelling that ATONE would simply be wrong.
  const feeDenom = chain.feeDenom ?? chain.denom;
  const feeSymbol = symbolForDenom(feeDenom);
  const since = new Date(stats.since).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <>
      <div
        className="gata-panel overflow-x-auto"
        style={{ ["--panel-accent" as string]: accent }}
      >
        <table className="gata-table w-full text-sm sm:min-w-[620px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">#</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">
                Operator
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Relays
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Share
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Fees paid
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Last relay
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.operators.map((op, i) => (
              <tr
                key={op.address}
                className="border-b border-border/50 last:border-0"
              >
                <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                  {i + 1}
                </td>
                <td className="px-4 py-2.5">
                  <Link
                    href={`/${chain.chainId}/accounts/${op.address}`}
                    className="font-mono text-xs transition-colors hover:text-primary"
                  >
                    {truncateMiddle(op.address, 14, 8)}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {op.txCount.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {stats.totalTxs > 0
                    ? `${((op.txCount / stats.totalTxs) * 100).toFixed(1)}%`
                    : "-"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {formatToken(op.feesPaid, chain.exponent, 2)}{" "}
                  <span className="text-xs">{feeSymbol}</span>
                </td>
                <td className="px-4 py-2.5 text-right text-xs text-muted-foreground whitespace-nowrap">
                  {timeAgo(op.lastTime)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {stats.totalTxs.toLocaleString()} relay transactions since {since},
        attributed to whoever paid the fee. Packet transfers sent by users are
        not counted - only the messages a relayer submits to deliver, acknowledge
        or time out a packet, and the client updates that keep a channel usable.
      </p>
    </>
  );
}
