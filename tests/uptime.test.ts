import { describe, it, expect } from "vitest";
import { consensusIdsFromPubkey, emptyUptime, RECENT_BAR_COUNT } from "@/lib/uptime";

// A real Cosmos Hub consensus key and the addresses it must produce. Both forms
// come from the same sha256(pubkey)[:20] — blocks carry the base64, the slashing
// module keys on the bech32 — so a change to either derivation breaks uptime
// silently, matching nothing rather than erroring.
const PUBKEY = "voVoXB0ArzZ57NgZgyAhrwa0mVabPijeqT0ebQJYPPc=";

describe("consensusIdsFromPubkey", () => {
  it("derives both encodings of the same consensus address", () => {
    const ids = consensusIdsFromPubkey(PUBKEY, "cosmos")!;
    expect(ids.valcons).toMatch(/^cosmosvalcons1[02-9ac-hj-np-z]+$/);
    // 20 bytes base64 is always 28 chars with padding.
    expect(ids.base64).toHaveLength(28);
  });

  it("is deterministic", () => {
    const a = consensusIdsFromPubkey(PUBKEY, "cosmos")!;
    const b = consensusIdsFromPubkey(PUBKEY, "cosmos")!;
    expect(a).toEqual(b);
  });

  it("uses the chain's own prefix", () => {
    expect(consensusIdsFromPubkey(PUBKEY, "atone")!.valcons.startsWith("atonevalcons1")).toBe(
      true
    );
    // Same key, same payload — only the prefix differs.
    expect(consensusIdsFromPubkey(PUBKEY, "atone")!.base64).toBe(
      consensusIdsFromPubkey(PUBKEY, "cosmos")!.base64
    );
  });

  it("returns null for junk rather than throwing", () => {
    // An empty key must not yield a valid-looking address that matches nothing.
    expect(consensusIdsFromPubkey("", "cosmos")).toBeNull();
    expect(consensusIdsFromPubkey("not-base64!!", "")).toBeNull();
  });
});

describe("emptyUptime", () => {
  it("is all-unknown, never a fabricated zero", () => {
    const u = emptyUptime();
    // A missing reading must not render as 0% uptime — that would libel a
    // validator that is actually fine.
    expect(u.ratio).toBeNull();
    expect(u.missed).toBeNull();
    expect(u.window).toBeNull();
    expect(u.bars).toEqual([]);
  });
});

describe("RECENT_BAR_COUNT", () => {
  it("stays small enough that the strip is one block fetch per bar", () => {
    expect(RECENT_BAR_COUNT).toBeGreaterThan(0);
    expect(RECENT_BAR_COUNT).toBeLessThanOrEqual(25);
  });
});
