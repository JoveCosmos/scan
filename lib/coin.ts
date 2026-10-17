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
 * Exact display amount: every significant decimal, grouped, never rounded.
 * Split with BigInt - amounts routinely exceed Number.MAX_SAFE_INTEGER, and
 * dividing them as floats prints ...124.9999 for ...125.
 */
export function exactAmount(raw: string, exponent: number): string {
  if (!/^\d+$/.test(raw)) return raw;
  const value = BigInt(raw);
  const base = BigInt(10) ** BigInt(exponent);
  const whole = (value / base).toLocaleString("en-US");
  if (exponent === 0) return whole;
  const fraction = (value % base).toString().padStart(exponent, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * A compact amount for a list cell: grouped, at most `maxFrac` decimals,
 * truncated rather than rounded (a display should never overstate), and never
 * abbreviated to K/M. A non-zero amount that truncates to zero shows as
 * "<0.0001" - a dust payment is not nothing.
 */
export function shortAmount(raw: string, exponent: number, maxFrac = 4): string {
  if (!/^\d+$/.test(raw)) return raw;
  const exact = exactAmount(raw, exponent);
  const [whole, frac = ""] = exact.split(".");
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  if (whole === "0" && !cut && BigInt(raw) > BigInt(0)) {
    return `<0.${"0".repeat(Math.max(0, maxFrac - 1))}1`;
  }
  return cut ? `${whole}.${cut}` : whole;
}

/**
 * Format a coin by its own denom rather than an assumed one.
 *
 * A transaction's fee is not always in the staking token - AtomOne pays fees in
 * PHOTON - so formatting every amount with the chain's headline symbol
 * mislabels them. A denom the app does not recognise is shown in base units
 * with a shortened denom, never scaled by a guessed power of ten.
 */
export function formatCoin(
  coin: { denom: string; amount: string },
  known: DenomInfo[],
  decimals = 4
): string {
  const hit = known.find((k) => k.denom === coin.denom);
  if (hit) return `${formatToken(coin.amount, hit.exponent, decimals)} ${hit.symbol}`;
  return `${exactAmount(coin.amount, 0)} ${shortDenom(coin.denom)}`;
}

/** Format a list of coins, e.g. a multi-denom fee. Empty renders as a dash. */
export function formatCoins(
  coins: { denom: string; amount: string }[],
  known: DenomInfo[],
  decimals = 4
): string {
  if (coins.length === 0) return "-";
  return coins.map((c) => formatCoin(c, known, decimals)).join(", ");
}

/** Exact coin: all decimals of a known denom, base units otherwise. */
function formatCoinExact(coin: { denom: string; amount: string }, known: DenomInfo[]): string {
  const hit = known.find((k) => k.denom === coin.denom);
  if (hit) return `${exactAmount(coin.amount, hit.exponent)} ${hit.symbol}`;
  return `${exactAmount(coin.amount, 0)} ${shortDenom(coin.denom)}`;
}

export function formatCoinsExact(coins: { denom: string; amount: string }[], known: DenomInfo[]): string {
  if (coins.length === 0) return "-";
  return coins.map((c) => formatCoinExact(c, known)).join(", ");
}

/** List-cell coin: truncated decimals, dust marker, no K/M. */
export function formatCoinShort(
  coin: { denom: string; amount: string },
  known: DenomInfo[],
  maxFrac = 4
): string {
  const hit = known.find((k) => k.denom === coin.denom);
  if (hit) return `${shortAmount(coin.amount, hit.exponent, maxFrac)} ${hit.symbol}`;
  return `${exactAmount(coin.amount, 0)} ${shortDenom(coin.denom)}`;
}

export function formatCoinsShort(
  coins: { denom: string; amount: string }[],
  known: DenomInfo[],
  maxFrac = 4
): string {
  if (coins.length === 0) return "-";
  const first = formatCoinShort(coins[0], known, maxFrac);
  return coins.length > 1 ? `${first} +${coins.length - 1}` : first;
}

/**
 * Display info for an IBC denom from its trace. The exponent comes from a chain
 * we carry whose staking or fee denom is the trace's base; failing that, the
 * micro/atto naming convention (u… is 6, a… is 18). Anything else stays
 * unscaled rather than guessed.
 */
export function denomInfoFromTrace(
  ibcDenom: string,
  trace: { base: string; symbol: string },
  carried: DenomInfo[]
): DenomInfo | null {
  const native = carried.find((d) => d.denom === trace.base);
  if (native) return { denom: ibcDenom, symbol: native.symbol, exponent: native.exponent };
  if (/^u[a-z][a-z0-9]{1,}$/.test(trace.base)) return { denom: ibcDenom, symbol: trace.symbol, exponent: 6 };
  if (/^a[a-z][a-z0-9]{1,}$/.test(trace.base)) return { denom: ibcDenom, symbol: trace.symbol, exponent: 18 };
  if (trace.base === "inj") return { denom: ibcDenom, symbol: "INJ", exponent: 18 };
  return { denom: ibcDenom, symbol: trace.symbol, exponent: 0 };
}
