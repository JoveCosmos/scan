import { describe, expect, test } from "vitest";
import { hashedAddress } from "@/lib/hashed-address";
import { escrowAddress } from "@/lib/address-kind";

describe("addresses derived from a name", () => {
  test("module account, realm account and ICS-20 escrow", () => {
    // AtomOne's photon module, Gnoswap's pool realm, the Hub's escrow for channel-141 (Osmosis).
    expect(hashedAddress("atone", "photon")).toBe("atone1mdzd4uhfvherp7tf8zqwusfetd6txaseqzfssq");
    expect(hashedAddress("g", "pkgPath:gno.land/r/gnoswap/pool")).toBe("g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v");
    expect(escrowAddress("cosmos", "channel-141")).toBe("cosmos1x54ltnyg88k0ejmk8ytwrhd3ltm84xehrnlslf");
  });
});
