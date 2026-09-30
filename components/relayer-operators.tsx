import Link from "next/link";
import type { ChainConfig } from "@/lib/chains";
import { symbolForDenom, accentFor } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { truncateMiddle, timeAgo } from "@/lib/format";
import { relayerStats } from "@/lib/indexer-db";
import { relayerPackets } from "@/lib/indexer-validator";
import { RELAYER_MSG_TYPES } from "@/lib/relayers";
import { AddressLink } from "@/components/address-link";
import { packetStats } from "@/lib/indexer-tx";

/** Messages that each deliver, acknowledge or time out one packet. */
const PACKET_MSG_TYPES = RELAYER_MSG_TYPES.filter((t) => !t.endsWith("MsgUpdateClient"));

function NotAvailable() {
  return (
    <div className="gata-panel px-5 py-7 text-center">
      <p className="font-mono text-sm uppercase tracking-[0.14em] text-[var(--gata-faint)]">N/A</p>
    </div>
  );
}

/**
 * The operators keeping this chain's channels alive, ranked by work done:
 * relay transactions, the packets inside them, fees paid and the last relay.
 */
export async function RelayerOperators({ chain }: { chain: ChainConfig }) {
  const [stats, packets, legs] = await Promise.all([
    relayerStats(chain.chainId, RELAYER_MSG_TYPES),
    relayerPackets(chain.chainId, PACKET_MSG_TYPES).catch(() => null),
    // Delivered legs from the index's packet table: a receive on an inbound
    // packet, an acknowledgement on an outbound one.
    packetStats(chain.chainId, 30).catch(() => null),
  ]);
  const legBy = new Map((legs?.relayers ?? []).map((r) => [r.relayer, r]));
  const accent = accentFor(chain);

  if (!stats || stats.operators.length === 0) return <NotAvailable />;

  // Fees are paid in the fee token where a chain has a separate one - AtomOne
  // charges PHOTON, and labelling that ATONE would simply be wrong.
  const feeSymbol = symbolForDenom(chain.feeDenom ?? chain.denom);
  const since = stats.fromGenesis
    ? null
    : new Date(stats.since).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <span className="inline-flex items-baseline gap-1 rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5">
          <span className="font-mono font-semibold text-foreground">
            {stats.totalTxs.toLocaleString()}
          </span>
          <span className="text-muted-foreground">relay txs</span>
        </span>
        {since ? (
          <span className="inline-flex items-baseline gap-1 rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5">
            <span className="text-muted-foreground">since</span>
            <span className="font-mono font-semibold text-foreground">{since}</span>
          </span>
        ) : null}
      </div>

      <div className="gata-panel overflow-x-auto" style={{ ["--panel-accent" as string]: accent }}>
        <table className="gata-table w-full text-sm sm:min-w-[680px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">#</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Operator</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Relays</th>
              {packets ? (
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Packets</th>
              ) : null}
              {legs ? (
                <>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Delivered 30d</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Median</th>
                </>
              ) : null}
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Share</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Fees paid</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Last relay</th>
            </tr>
          </thead>
          <tbody>
            {stats.operators.map((op, i) => (
              <tr key={op.address} className="border-b border-border/50 last:border-0">
                <td data-label="#" className="px-4 py-2.5 text-muted-foreground tabular-nums">
                  {i + 1}
                </td>
                <td data-label="Operator" data-primary className="px-4 py-2.5">
                  <AddressLink
                    address={op.address}
                    label={truncateMiddle(op.address, 14, 8)}
                    className="font-mono text-xs"
                  />
                </td>
                <td data-label="Relays" className="px-4 py-2.5 text-right tabular-nums">
                  {op.txCount.toLocaleString()}
                </td>
                {packets ? (
                  <td data-label="Packets" className="px-4 py-2.5 text-right tabular-nums">
                    {(packets.get(op.address) ?? 0).toLocaleString()}
                  </td>
                ) : null}
                {legs ? (
                  <>
                    <td data-label="Delivered 30d" className="px-4 py-2.5 text-right tabular-nums">
                      {(legBy.get(op.address)?.packets ?? 0).toLocaleString()}
                    </td>
                    <td data-label="Median" className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {legBy.get(op.address)?.medianLatency != null
                        ? `${legBy.get(op.address)!.medianLatency}s`
                        : "-"}
                    </td>
                  </>
                ) : null}
                <td data-label="Share" className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {stats.totalTxs > 0
                    ? `${((op.txCount / stats.totalTxs) * 100).toFixed(1)}%`
                    : "-"}
                </td>
                <td data-label="Fees paid" className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                  {formatToken(op.feesPaid, chain.exponent, 2)}{" "}
                  <span className="text-xs">{feeSymbol}</span>
                </td>
                <td data-label="Last relay" className="px-4 py-2.5 text-right text-xs whitespace-nowrap">
                  <Link
                    href={`/${chain.chainId}/blocks/${op.lastHeight}`}
                    className="text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
                  >
                    #{op.lastHeight.toLocaleString()}
                  </Link>{" "}
                  <span className="text-muted-foreground">{timeAgo(op.lastTime)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
