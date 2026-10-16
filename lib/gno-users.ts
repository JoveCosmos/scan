import type { ChainConfig } from "@/lib/chains";
import type { DeckCell } from "@/components/row-deck";
import { truncateMiddle } from "@/lib/format";
import { followEvents, type EventTx } from "@/lib/gno-follow";

/**
 * Registered names on gno.land, from gno.land/r/sys/users: Registered (name,
 * address), Updated (alias, address: the new name; the old ones keep
 * resolving) and Deleted (address). Read from genesis and followed by
 * followEvents, so a new name shows within a minute.
 */

const USERS = "gno.land/r/sys/users";

export interface GnoNames {
  /** Address to its current name. */
  byAddress: Map<string, string>;
  /** Every name, old ones included, to its address. */
  byName: Map<string, string>;
}

/** Fold one window's events into the names. Exported for tests. */
export function applyUsers(state: GnoNames, txs: EventTx[]) {
  for (const tx of txs) {
    for (const e of tx.response?.events ?? []) {
      if (e.pkg_path !== USERS || !e.type) continue;
      const attr = (k: string) => e.attrs?.find((a) => a.key === k)?.value ?? "";
      const address = attr("address");
      if (!address) continue;
      if (e.type === "Registered" || e.type === "Updated") {
        const name = attr(e.type === "Registered" ? "name" : "alias");
        if (!name) continue;
        state.byAddress.set(address, name);
        state.byName.set(name, address);
      } else if (e.type === "Deleted") {
        state.byAddress.delete(address);
        for (const [name, owner] of state.byName) if (owner === address) state.byName.delete(name);
      }
    }
  }
}

/** The chain's registered names. Null when the tx-indexer cannot be read. */
export function gnoNames(chain: ChainConfig): Promise<GnoNames | null> {
  return followEvents(
    "users",
    chain,
    USERS,
    () => ({ byAddress: new Map<string, string>(), byName: new Map<string, string>() }),
    applyUsers
  );
}

/** "@moul" for a named address, else null. */
export function atName(names: GnoNames | null | undefined, address: string | null | undefined): string | null {
  const name = address ? names?.byAddress.get(address) : undefined;
  return name ? `@${name}` : null;
}

/**
 * A list cell for an address: its registered name, else the realm it belongs
 * to ("r/gnoswap/pool", from `realms`, see realmByAddress), else the address
 * shortened.
 */
export function addressCell(
  names: GnoNames | null | undefined,
  address: string,
  head = 8,
  tail = 6,
  realms?: Map<string, string> | null
): DeckCell {
  const name = atName(names, address);
  if (name) return { v: name, address };
  const realm = realms?.get(address);
  if (realm) return { v: realm.replace(/^gno\.land\//, ""), mono: true, address };
  return { v: truncateMiddle(address, head, tail), mono: true, address };
}
