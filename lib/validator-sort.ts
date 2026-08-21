import type { ValidatorUptime } from "@/lib/uptime";
import type { StakeDelta } from "@/lib/stake-delta";

/**
 * Ranking and filtering the validator set.
 *
 * Lifted out of the component so it can be tested as what it is — pure
 * functions over a list — and so the table itself is only presentation. The
 * comparisons carry real decisions (BigInt for stake, share rather than amount
 * for self-bond, unknowns sinking rather than posing as zero), which is exactly
 * the kind of thing that should not live inside a render.
 */

export interface ValidatorRow {
  rank: number;
  operatorAddress: string;
  moniker: string;
  votingPower: number;
  /** Base denom, as a string — a large validator's stake exceeds a safe double. */
  tokens: string;
  /** Pre-formatted by the server, which owns the chain's exponent. */
  tokensLabel: string;
  commissionRate: number;
  jailed: boolean;
  status: string;
  uptime: ValidatorUptime;
  delta: StakeDelta | null;
  /**
   * Times jailed within the indexed window, or null when the indexer cannot
   * say. Null and zero are different claims: zero means "never, in the window
   * shown", null means the column has no basis at all.
   */
  jailings: { count: number; tombstoned: boolean } | null;
  /** The validator's own stake, or null when the query did not answer. */
  selfBond: { amount: string; share: number | null } | null;
}

export type SortKey =
  | "rank"
  | "moniker"
  | "tokens"
  | "selfBond"
  | "delta"
  | "commission"
  | "uptime"
  | "jailed"
  | "jailings";

/**
 * Exported for tests, like the sort below.
 *
 * Applied after sorting, so ranks stay the chain's rather than the filtered
 * list's. Matches the operator address as well as the moniker: pasting an
 * address in is how you find a validator you know by address, and it costs
 * nothing to support.
 */
export function filterValidators(rows: ValidatorRow[], query: string): ValidatorRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (v) =>
      v.moniker.toLowerCase().includes(q) ||
      v.operatorAddress.toLowerCase().includes(q)
  );
}

/** Exported for tests: the sort is the substantive logic in this component. */
export function sortValidators(
  rows: ValidatorRow[],
  key: SortKey,
  dir: "asc" | "desc"
): ValidatorRow[] {
  const copy = [...rows];
  copy.sort((a, b) => (dir === "asc" ? compare(a, b, key) : -compare(a, b, key)));
  return copy;
}

function compare(a: ValidatorRow, b: ValidatorRow, key: SortKey): number {
  switch (key) {
    case "rank":
      return a.rank - b.rank;
    case "moniker":
      return a.moniker.localeCompare(b.moniker, undefined, { sensitivity: "base" });
    case "tokens": {
      // BigInt: stake exceeds what a double compares exactly.
      const x = BigInt(a.tokens);
      const y = BigInt(b.tokens);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "selfBond": {
      // Sorted by share, not amount: the question is how much of its own stake
      // an operator has behind the delegations, which a raw total cannot say.
      const x = a.selfBond?.share ?? -1;
      const y = b.selfBond?.share ?? -1;
      return x - y;
    }
    case "delta": {
      // Unknown deltas sink to the bottom either way rather than posing as zero.
      if (!a.delta && !b.delta) return 0;
      if (!a.delta) return -1;
      if (!b.delta) return 1;
      return a.delta.change < b.delta.change
        ? -1
        : a.delta.change > b.delta.change
          ? 1
          : 0;
    }
    case "commission":
      return a.commissionRate - b.commissionRate;
    case "uptime": {
      const x = a.uptime.ratio;
      const y = b.uptime.ratio;
      if (x === null && y === null) return 0;
      if (x === null) return -1;
      if (y === null) return 1;
      return x - y;
    }
    case "jailed": {
      // Never-jailed sorts as the oldest possible date, so "most recently
      // jailed" surfaces first on a descending sort.
      const x = a.uptime.jailedUntil ? Date.parse(a.uptime.jailedUntil) : 0;
      const y = b.uptime.jailedUntil ? Date.parse(b.uptime.jailedUntil) : 0;
      return x - y;
    }
    case "jailings": {
      // Unknown sorts below zero: a validator we have no history for should not
      // outrank one we know was never jailed.
      const x = a.jailings ? a.jailings.count : -1;
      const y = b.jailings ? b.jailings.count : -1;
      return x - y;
    }
  }
}
