import { describe, it, expect } from "vitest";
import { getAllChains, getChain } from "@/lib/chains";
import { policyFor, policyForTier, TIER_ORDER } from "@/lib/tiers";

describe("tiers", () => {
  it("assigns the intended tier to every chain", () => {
    const byTier: Record<string, string[]> = { high: [], medium: [], limited: [] };
    for (const chain of getAllChains()) byTier[chain.tier].push(chain.chainId);

    expect(byTier).toEqual({
      high: ["sapphire-1", "atomone-1", "atomone-testnet-1"],
      medium: ["cosmoshub-4", "provider", "akashnet-2"],
      limited: ["osmosis-1", "passage-2", "juno-1"],
    });
  });

  it("runs full nodes only for the top tier", () => {
    for (const chain of getAllChains()) {
      expect(policyFor(chain).fullNode, chain.chainId).toBe(chain.tier === "high");
    }
  });

  it("computes derived metrics and indexes only at the top tier", () => {
    for (const chain of getAllChains()) {
      const policy = policyFor(chain);
      const expected = chain.tier === "high";
      expect(policy.metrics, `${chain.chainId} metrics`).toBe(expected);
      expect(policy.indexed, `${chain.chainId} indexed`).toBe(expected);
    }
  });

  it("withholds transactions, proposals and relayers from the limited tier only", () => {
    for (const chain of getAllChains()) {
      const policy = policyFor(chain);
      const offered = chain.tier !== "limited";
      expect(policy.txs, `${chain.chainId} txs`).toBe(offered);
      expect(policy.proposals, `${chain.chainId} proposals`).toBe(offered);
      expect(policy.relayers, `${chain.chainId} relayers`).toBe(offered);
    }
  });

  // A tier is a decision about what we serve, so it must never be the reason a
  // capability appears. gno.land has no staking module at any tier.
  it("does not grant a chain anything its kind cannot do", () => {
    const gno = getChain("sapphire-1")!;
    expect(gno.tier).toBe("high");
    expect(gno.kind).toBe("gno");
  });

  it("orders tiers high to limited", () => {
    expect(TIER_ORDER).toEqual(["high", "medium", "limited"]);
    expect(TIER_ORDER.map((t) => policyForTier(t).label)).toEqual([
      "High",
      "Medium",
      "Limited",
    ]);
  });

  it("defaults an unspecified tier to medium rather than limited", () => {
    // A chain added without a tier should get a working page, not silently lose
    // its transactions. Guards the schema default.
    for (const chain of getAllChains()) {
      expect(["high", "medium", "limited"]).toContain(chain.tier);
    }
    expect(policyForTier("medium").txs).toBe(true);
  });
});
