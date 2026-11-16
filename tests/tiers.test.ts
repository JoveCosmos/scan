import { describe, it, expect } from "vitest";
import { getAllChains, getChain } from "@/lib/chains";
import { policyFor } from "@/lib/tiers";

describe("tiers", () => {
  it("assigns the intended tier to every chain", () => {
    const byTier: Record<string, string[]> = { high: [], medium: [], limited: [] };
    for (const chain of getAllChains()) byTier[chain.tier].push(chain.chainId);

    expect(byTier).toEqual({
      high: ["gnoland-1", "onyx-1", "atomone-1", "atomone-testnet-1"],
      medium: ["cosmoshub-4", "provider"],
      limited: ["passage-2", "juno-1"],
    });
  });

  it("computes derived metrics only at the top tier", () => {
    for (const chain of getAllChains()) {
      expect(policyFor(chain).metrics, `${chain.chainId} metrics`).toBe(
        chain.tier === "high"
      );
    }
  });

  // Indexed is a fact about the indexer, not a tier consequence. Marking it as
  // one had the app querying Postgres for chains it had never been pointed at.
  it("indexes only the chains the index actually holds", () => {
    const indexed = getAllChains().filter((c) => c.indexed).map((c) => c.chainId);
    expect(indexed).toEqual(["atomone-1"]);
  });

  it("keeps indexed off the tier policy", () => {
    expect(policyFor(getChain("atomone-1")!)).not.toHaveProperty("indexed");
  });

  it("withholds transactions and proposals from the limited tier only", () => {
    for (const chain of getAllChains()) {
      const policy = policyFor(chain);
      const offered = chain.tier !== "limited";
      expect(policy.txs, `${chain.chainId} txs`).toBe(offered);
      expect(policy.proposals, `${chain.chainId} proposals`).toBe(offered);
    }
  });

  // A tier is a decision about what we serve, so it must never be the reason a
  // capability appears. gno.land has no staking module at any tier.
  it("does not grant a chain anything its kind cannot do", () => {
    const gno = getChain("gnoland-1")!;
    expect(gno.tier).toBe("high");
    expect(gno.kind).toBe("gno");
  });

  // Tiers are never rendered, so a policy is flags only. A label or blurb
  // reappearing here is the first step towards one being printed.
  it("carries no display text", () => {
    expect(Object.keys(policyFor(getChain("juno-1")!)).sort()).toEqual([
      "metrics",
      "proposals",
      "tier",
      "txs",
    ]);
  });

  it("defaults an unspecified tier to medium rather than limited", () => {
    // A chain added without a tier should get a working page, not silently lose
    // its transactions. Guards the schema default.
    for (const chain of getAllChains()) {
      expect(["high", "medium", "limited"]).toContain(chain.tier);
    }
    expect(policyFor(getChain("cosmoshub-4")!).txs).toBe(true);
  });
});
