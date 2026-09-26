import { exactAmount, shortAmount, shortDenom } from "@/lib/coin";
import type { TxTransfer } from "@/lib/tx-parties";
import { directionFor } from "@/lib/tx-parties";
import { cn } from "@/lib/utils";

/**
 * The value a transaction moved.
 *
 * Given a `viewer` address the figure is signed and coloured from that
 * account's point of view; without one it is shown plainly, since a global list
 * has no side to take.
 *
 * A message type that carries no amount (a reward withdrawal, a vote) renders a
 * dash — the amount exists only in the events, and inventing one would be worse
 * than admitting we do not have it.
 *
 * Takes denom/exponent/symbol as plain values rather than a ChainConfig: this
 * renders inside client components, and importing lib/chains would pull node:fs
 * into the browser bundle and stop them hydrating.
 */
export function TxAmount({
  denom,
  exponent,
  symbol,
  transfer,
  viewer,
}: {
  denom: string;
  exponent: number;
  symbol: string;
  transfer: TxTransfer | null;
  viewer?: string;
}) {
  if (!transfer || transfer.amount.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  const direction = viewer ? directionFor(transfer, viewer) : null;

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {transfer.amount.map((coin, i) => {
        // Only the chain's own denom has a known exponent; an IBC or factory
        // denom is shown raw rather than scaled by the wrong power of ten.
        const native = coin.denom === denom;
        const value = native
          ? `${shortAmount(coin.amount, exponent, 4)} ${symbol}`
          : `${exactAmount(coin.amount, 0)} ${shortDenom(coin.denom)}`;

        return (
          <span
            key={`${coin.denom}-${i}`}
            className={cn(
              "font-mono text-xs tabular-nums",
              direction === "out" && "text-[var(--gata-burn)]",
              direction === "in" && "text-[var(--gata-green)]"
            )}
            title={native ? undefined : coin.denom}
          >
            {direction === "out" ? "−" : direction === "in" ? "+" : ""}
            {value}
          </span>
        );
      })}
    </span>
  );
}
