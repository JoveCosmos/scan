import type { NextConfig } from "next";

/**
 * gno.land's testnet relaunches under a new chain id: topaz-1, then
 * sapphire-1, then pearl-1, now onyx-1 (2026-09-28). Old links go to the
 * current one. Add each retired id to this list when the next one replaces it.
 */
const RETIRED_GNO_TESTNETS = "topaz-1|sapphire-1|pearl-1";
const GNO_TESTNET = "onyx-1";

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
    ];
  },
};

export default nextConfig;
