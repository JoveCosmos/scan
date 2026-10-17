/**
 * GRC20 tokens on gno.land: the shapes Scan's pages share and the token link.
 * The figures themselves come from our index (gno_grc20_token, _transfer and
 * _balance, migration 014), read in lib/gno-token-data.ts.
 */

export interface TokenTransfer {
  /** Uppercase hex. */
  txHash: string;
  height: number;
  /** "" for a mint. */
  from: string;
  /** "" for a burn. */
  to: string;
  amount: bigint;
}

export interface AccountTransfer {
  /** Uppercase hex. */
  txHash: string;
  height: number;
  /** The token's key, "<realm>.<SYMBOL>.<seq>". */
  token: string;
  /** "" for a mint. */
  from: string;
  /** "" for a burn. */
  to: string;
  /** Base units, as a decimal string. */
  amount: string;
}

/** Transfers on one page of an account's Token transfers tab. */
export const ACCOUNT_TRANSFERS_PAGE = 100;

/** The URL key for a token: its realm path without gno.land/, then its symbol. */
export function tokenHref(chainId: string, token: { realm: string; symbol: string }): string {
  return `/${chainId}/tokens/${token.realm.replace(/^gno\.land\//, "")}/${encodeURIComponent(token.symbol)}`;
}
