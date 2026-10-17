import { cached } from "@/lib/cache";
import type { ChainConfig } from "@/lib/chains";

/**
 * Where a validator's logo comes from.
 *
 * First choice is Cosmostation's chainlist, which publishes one image per
 * operator address (the same set Mintscan shows). Second is the picture on
 * the Keybase account named by the validator's identity. The browser walks the
 * list and falls back to a monogram, so a missing image never shows as broken.
 */

const CHAINLIST = "https://raw.githubusercontent.com/cosmostation/chainlist/main/chain";

/** Cosmostation's folder for each chain we carry; absent means none exists. */
const CHAINLIST_DIR: Record<string, string> = {
  "cosmoshub-4": "cosmos",
  "atomone-1": "atomone",
  "akashnet-2": "akash",
  "juno-1": "juno",
  "osmosis-1": "osmosis",
  "passage-2": "passage",
  provider: "ics-testnet-provider",
  "gnoland-1": "gno",
  "onyx-1": "gno-testnet",
};

function chainlistLogo(chainId: string, operator: string): string | null {
  const dir = CHAINLIST_DIR[chainId];
  return dir ? `${CHAINLIST}/${dir}/moniker/${operator}.png` : null;
}

const WEEK = 7 * 24 * 60 * 60_000;

// At most a few Keybase requests in flight: a full validator set would
// otherwise fire hundreds at once and get rate-limited.
let active = 0;
const queue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((r) => queue.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    queue.shift()?.();
  }
}
const pending = new Map<string, Promise<string | null>>();

/** The Keybase picture for an identity, cached for a week. */
export function keybasePicture(identity: string | undefined | null): Promise<string | null> {
  const id = (identity ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(id)) return Promise.resolve(null);
  return cached(`keybase-pic:${id}`, WEEK, () => limited(async () => {
    try {
      const res = await fetch(
        `https://keybase.io/_/api/1.0/user/lookup.json?key_suffix=${id}&fields=pictures`,
        { cache: "no-store", signal: AbortSignal.timeout(3000) }
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        them?: { pictures?: { primary?: { url?: string } } }[];
      };
      return json.them?.[0]?.pictures?.primary?.url ?? null;
    } catch {
      return null;
    }
  }));
}

/**
 * Logo candidates for a whole validator set without waiting on Keybase: the
 * chainlist image always, the Keybase picture once a background lookup has
 * cached it. Lookups start here and land for the next render.
 */
export async function validatorLogoMap(
  chain: Pick<ChainConfig, "chainId">,
  validators: { operatorAddress: string; identity?: string | null }[],
  waitMs = 400
): Promise<Map<string, string[]>> {
  const lookups = validators.map(async (v) => {
    const key = `${chain.chainId}:${v.identity ?? ""}`;
    let p = pending.get(key);
    if (!p) {
      p = keybasePicture(v.identity).finally(() => pending.delete(key));
      pending.set(key, p);
    }
    return [v.operatorAddress, p] as const;
  });
  const settled = await Promise.all(lookups);
  // Give cached lookups a moment; anything slower arrives on a later view.
  const deadline = new Promise<null>((r) => setTimeout(() => r(null), waitMs));
  const out = new Map<string, string[]>();
  await Promise.all(
    settled.map(async ([operator, p]) => {
      const pic = await Promise.race([p, deadline]);
      const list = [chainlistLogo(chain.chainId, operator), pic].filter(
        (u): u is string => Boolean(u)
      );
      out.set(operator, list);
    })
  );
  return out;
}

/**
 * Blocks with their proposer's logos attached, for lists that show the
 * proposer. Never waits on Keybase (a polled feed must not slow down):
 * chainlist images always, Keybase pictures once cached.
 */
export async function withProposerLogos<
  B extends { proposerOperator: string | null },
>(
  chain: Pick<ChainConfig, "chainId">,
  blocks: B[],
  validators: { operatorAddress: string; identity?: string | null }[]
): Promise<(B & { proposerLogos: string[] })[]> {
  const byOperator = new Map(validators.map((v) => [v.operatorAddress, v]));
  const proposers = [
    ...new Set(blocks.map((b) => b.proposerOperator).filter((o): o is string => Boolean(o))),
  ].map((o) => byOperator.get(o) ?? { operatorAddress: o });
  const logos = await validatorLogoMap(chain, proposers, 0);
  return blocks.map((b) => ({
    ...b,
    proposerLogos: b.proposerOperator ? logos.get(b.proposerOperator) ?? [] : [],
  }));
}
