import type { NextConfig } from "next";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * gno.land's testnet relaunches under a new chain id: topaz-1, then
 * sapphire-1, then pearl-1, now onyx-1 (2026-09-28). Old links go to the
 * current one. Add each retired id to this list when the next one replaces it.
 */
const RETIRED_GNO_TESTNETS = "topaz-1|sapphire-1|pearl-1";
const GNO_TESTNET = "onyx-1";

/**
 * Each chain's short name ("atomone-testnet") to its chain id
 * ("atomone-testnet-1"). Other apps link by name: the AtomOne app's faucet sent
 * users to /atomone-testnet/txs/…, which is no chain id, so the page said the
 * transaction could not be found. A name two chains share (gnoland: mainnet
 * and testnet) goes to the mainnet; a name that is itself a chain id is left.
 */
function chainNameAliases(): { name: string; chainId: string }[] {
  const dir = join(process.cwd(), "config", "chains");
  const chains = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) =>
        JSON.parse(readFileSync(join(dir, f), "utf8")) as {
          chainId: string;
          name?: string;
          network?: string;
        }
    );
  const ids = new Set(chains.map((c) => c.chainId));
  const byName = new Map<string, { chainId: string; network?: string }>();
  for (const c of chains) {
    if (!c.name || c.name === c.chainId || ids.has(c.name)) continue;
    if (!/^[a-z0-9-]+$/.test(c.name)) continue;
    const held = byName.get(c.name);
    if (!held || (held.network === "testnet" && c.network !== "testnet")) {
      byName.set(c.name, { chainId: c.chainId, network: c.network });
    }
  }
  return [...byName].map(([name, { chainId }]) => ({ name, chainId }));
}

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // An address is the same key on every testnet, so its page carries over.
      {
        source: `/:old(${RETIRED_GNO_TESTNETS})/:kind(accounts|validators)/:path*`,
        destination: `/${GNO_TESTNET}/:kind/:path*`,
        permanent: false,
      },
      // Heights and hashes do not: each relaunch starts from a new genesis, so
      // block 100 on pearl is a different block on onyx. Those land on the
      // chain's home page instead of on an unrelated block.
      {
        source: `/:old(${RETIRED_GNO_TESTNETS})/:path*`,
        destination: `/${GNO_TESTNET}`,
        permanent: false,
      },
      // A chain's name stands for the same chain, so the whole path carries.
      ...chainNameAliases().map(({ name, chainId }) => ({
        source: `/${name}/:path*`,
        destination: `/${chainId}/:path*`,
        permanent: false,
      })),
    ];
  },
};

export default nextConfig;
