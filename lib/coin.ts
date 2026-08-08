import { formatToken } from "@/lib/overview";

/** A denom the app knows how to display: its ticker and decimal places. */
export interface DenomInfo {
  denom: string;
  symbol: string;
  exponent: number;
}

/** `ibc/1A2B…` and `factory/osmo1…/foo` are too long for a table cell. */
export function shortDenom(denom: string): string {
  if (denom.startsWith("ibc/")) return `ibc/${denom.slice(4, 10)}…`;
  if (denom.startsWith("factory/")) return denom.split("/").pop() ?? denom;
  return denom.length > 12 ? `${denom.slice(0, 12)}…` : denom;
}

/**
 * Format a coin by its own denom rather than an assumed one.
 *
 * A transaction's fee is not always in the staking token — AtomOne pays fees in
 * PHOTON — so formatting every amount with the chain's headline symbol
 * mislabels them. A denom the app does not recognise is shown raw with a
 * shortened denom, never scaled by the wrong power of ten.
 */
export function formatCoin(
  coin: { denom: string; amount: string },
  known: DenomInfo[],
  decimals = 4
): string {
  const hit = known.find((k) => k.denom === coin.denom);
  if (hit) return `${formatToken(coin.amount, hit.exponent, decimals)} ${hit.symbol}`;
  return `${Number(coin.amount).toLocaleString()} ${shortDenom(coin.denom)}`;
}

/** Format a list of coins, e.g. a multi-denom fee. Empty renders as a dash. */
export function formatCoins(
  coins: { denom: string; amount: string }[],
  known: DenomInfo[],
  decimals = 4
): string {
  if (coins.length === 0) return "—";
  return coins.map((c) => formatCoin(c, known, decimals)).join(", ");
}
