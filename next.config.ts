import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        // gno.land's testnet was sunset and relaunched as sapphire-1, taking
        // every /topaz-1/… URL with it. The chain id is the only thing that
        // changed, so the rest of the path still resolves — a redirect keeps
        // old links working instead of 404ing them.
        //
        // Permanent: topaz is gone, not moved temporarily. If a future testnet
        // rolls the id again, add its predecessor here too rather than
        // replacing this one; the ids do not collide.
        source: "/topaz-1/:path*",
        destination: "/sapphire-1/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
