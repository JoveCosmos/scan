import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import type { ChainConfig } from "@/lib/chains";
import { symbolFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { TxAmount } from "@/components/tx-amount";
import { AddressLink } from "@/components/address-link";
import { directionFor, type TxTransfer } from "@/lib/tx-parties";

/**
 * The other side of a transfer, from this account's point of view.
 *
 * An arrow alone is ambiguous on a page that is already about one address, so
 * the direction is spelled out: "from X" for value arriving, "to Y" for value
 * leaving.
 */
function Counterparty({
  chainId,
  transfer,
  viewer,
}: {
  chainId: string;
  transfer: TxTransfer | null;
  viewer: string;
}) {
  if (!transfer) return <span className="text-muted-foreground">—</span>;

  const direction = directionFor(transfer, viewer);
  const other =
    direction === "out" ? transfer.to : direction === "in" ? transfer.from : null;

  if (direction === "self") {
    return <span className="text-xs text-muted-foreground">self</span>;
  }
  // The account is not a party — a vote, a grant — so there is no counterparty
  // to name rather than an unknown one.
  if (!direction || !other) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">
        {direction === "out" ? "to" : "from"}
      </span>
      <AddressLink chainId={chainId} address={other} />
    </span>
  );
}

/**
 * Transactions this address sent or received. Streamed separately from the
 * balances above, because on Cosmos it costs two indexed tx searches.
 */
export async function AccountTxs({
  chain,
  address,
}: {
  chain: ChainConfig;
  address: string;
}) {
  const { txs, total, failed } = await getAdapter(chain).getAccountTxs(address);
  const symbol = symbolFor(chain);

  if (failed) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          Could not load transaction history — the node did not respond.
        </p>
      </div>
    );
  }

  if (txs.length === 0) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No transactions found for this address.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="gata-panel overflow-x-auto">
        <table className="gata-table w-full text-sm sm:min-w-[720px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">Hash</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Type</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">
                Counterparty
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Amount
              </th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Height
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Fee
              </th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                Age
              </th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx) => (
              <tr
                key={tx.hash}
                className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
              >
                <td data-label="Hash" data-primary className="px-4 py-3">
                  <Link
                    href={`/${chain.chainId}/txs/${encodeURIComponent(tx.hash)}`}
                    className="-my-2 inline-block py-2 font-mono text-xs text-primary hover:underline"
                    title={tx.hash}
                  >
                    {truncateMiddle(tx.hash, 10, 8)}
                  </Link>
                </td>
                <td data-label="Type" className="px-4 py-3 text-xs">
                  {tx.messages[0]?.label ?? "—"}
                  {tx.messages.length > 1 ? (
                    <span className="ml-1 text-muted-foreground">
                      +{tx.messages.length - 1}
                    </span>
                  ) : null}
                </td>
                <td data-label="Counterparty" className="px-4 py-3">
                  <Counterparty
                    chainId={chain.chainId}
                    transfer={tx.transfer}
                    viewer={address}
                  />
                </td>
                <td data-label="Amount" className="px-4 py-3 text-right">
                  <TxAmount
                    denom={chain.denom}
                    exponent={chain.exponent}
                    symbol={symbolFor(chain)}
                    transfer={tx.transfer}
                    viewer={address}
                  />
                </td>
                <td data-label="Status" className="px-4 py-3">
                  {tx.code === null ? (
                    <span className="text-xs text-muted-foreground">Unindexed</span>
                  ) : tx.code === 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--gata-green)]">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Success
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--gata-burn)]">
                      <XCircle className="h-3.5 w-3.5" />
                      Failed
                    </span>
                  )}
                </td>
                <td
                  data-label="Height"
                  className="px-4 py-3 text-right font-mono text-xs"
                >
                  <Link
                    href={`/${chain.chainId}/blocks/${tx.height}`}
                    className="-my-2 inline-block py-2 text-muted-foreground hover:text-foreground"
                  >
                    {Number(tx.height).toLocaleString()}
                  </Link>
                </td>
                <td
                  data-label="Fee"
                  className="px-4 py-3 text-right font-mono text-xs"
                >
                  {tx.fee.length > 0
                    ? `${formatToken(tx.fee[0].amount, chain.exponent, 4)} ${symbol}`
                    : "—"}
                </td>
                <td
                  data-label="Age"
                  className="px-4 py-3 text-right text-xs text-muted-foreground"
                >
                  {timeAgo(tx.time)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total !== null && total > txs.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the {txs.length} most recent of {total.toLocaleString()}.
        </p>
      ) : null}
    </>
  );
}
