import type { ChainConfig } from "@/lib/chains";
import { symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { RowDeck, type DeckRow } from "@/components/row-deck";

/**
 * Delegators, largest first. Still streamed separately — a validator with
 * thousands of delegations makes this the slowest read on the page, and it is
 * the one section here whose absence costs nothing above it, since the deck
 * owns the whole tab it sits in.
 *
 * A server component rendering a client deck: the rows are plain data, so the
 * ranking happens once on the server and the browser never sees the adapter.
 */
export async function ValidatorDelegators({
  chain,
  operatorAddress,
}: {
  chain: ChainConfig;
  operatorAddress: string;
}) {
  const { delegators, total, truncated, failed } = await getAdapter(
    chain
  ).getDelegators(operatorAddress);
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  // The largest share sets the bar scale, so the bars compare delegators to the
  // biggest one rather than to a validator's whole stake — on a set of 4,000
  // every bar against the total would be an invisible sliver.
  const topShare = delegators[0]?.share || 1;

  const rows: DeckRow[] = delegators.map((d, i) => ({
    key: d.address,
    cells: [
      { v: String(i + 1), mono: true, dim: true, align: "right" },
      { v: truncateMiddle(d.address, 14, 8), mono: true, tone: "accent" },
      {
        v: `${formatToken(d.amount, chain.exponent, 2)} ${symbol}`,
        mono: true,
        align: "right",
      },
      {
        v: `${(d.share * 100).toFixed(2)}%`,
        mono: true,
        align: "right",
        bar: d.share / topShare,
      },
    ],
    detail: {
      title: truncateMiddle(d.address, 16, 10),
      sub: `#${i + 1} of ${delegators.length}`,
      rows: [
        {
          label: "Delegator",
          value: d.address,
          mono: true,
          href: `/${chain.chainId}/accounts/${d.address}`,
        },
        {
          label: "Delegated",
          value: `${formatToken(d.amount, chain.exponent, 6)} ${symbol}`,
          mono: true,
        },
        { label: "Share", value: `${(d.share * 100).toFixed(4)}%`, mono: true },
      ],
      action: {
        label: "Account",
        href: `/${chain.chainId}/accounts/${d.address}`,
      },
    },
  }));

  // The ranking is only complete when we read every delegation, so a capped
  // read says so. Without it "the 200 largest" and "all 200" look identical.
  const partial =
    total !== null && total > delegators.length
      ? `Showing the ${delegators.length} largest of ${total.toLocaleString()} delegators${truncated ? "+" : ""}.`
      : null;

  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "#", align: "right", width: "10%" },
        { label: "Delegator" },
        { label: "Amount", align: "right", width: "28%" },
        { label: "Share", align: "right", width: "18%", phoneHide: true },
      ]}
      rows={rows}
      toolbar={
        partial ? (
          <p className="text-[11px] text-muted-foreground">{partial}</p>
        ) : undefined
      }
      empty={
        failed
          ? "N/A"
          : "No delegations found."
      }
    />
  );
}
