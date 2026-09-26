import { describe, expect, it, vi, beforeEach } from "vitest";

// The seam between the index's tx_party walk and the older union below its
// coverage floor: one page may draw from both, and paging must not skip or
// repeat rows across it.
const party = vi.fn();
const legacy = vi.fn();

vi.mock("@/lib/indexer-tx", async (orig) => {
  const real = await orig<typeof import("@/lib/indexer-tx")>();
  return { ...real, partyHistory: (...a: unknown[]) => party(...a) };
});
vi.mock("@/lib/indexer-db", () => ({
  accountTxsFromIndexer: (...a: unknown[]) => legacy(...a),
  poolFor: () => null,
  recentTxsFromIndexer: async () => null,
  indexerFreshness: async () => null,
}));

import { getCosmosAccountTxs } from "@/lib/accounts";
import type { ChainConfig } from "@/lib/chains";

const chain = { chainId: "atomone-1", kind: "cosmos" } as unknown as ChainConfig;
const addr = "atone1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

const ptx = (height: string, hash: string) => ({
  hash,
  height,
  time: "2026-09-26T00:00:00Z",
  code: 0,
  msgTypes: [],
  roles: 8,
  feeCoins: [],
  gasUsed: null,
  gasWanted: null,
  signer: null,
  movements: [],
});
const ltx = (height: string, hash: string) => ({
  hash,
  height,
  time: "2026-09-01T00:00:00Z",
  code: 0,
  msgTypes: [],
  feeDenom: null,
  feeAmount: null,
  transfer: null,
});

beforeEach(() => {
  party.mockReset();
  legacy.mockReset();
});

describe("account history across the tx_party floor", () => {
  it("fills a short page from below the floor and continues with the old cursor", async () => {
    party.mockResolvedValue({ txs: [ptx("500", "BB")], more: false, floor: 400, exactMovements: true });
    legacy.mockResolvedValue({ txs: [ltx("300", "AA")], more: true, since: "x", fromGenesis: false });
    const res = await getCosmosAccountTxs(chain, addr, { limit: 2 });
    expect(res.txs.map((t) => t.hash)).toEqual(["BB", "AA"]);
    expect(res.txs[0].roles).toEqual(["sent"]);
    // Below the floor only: height 400, and "~" sorts after every hash.
    expect(legacy.mock.calls[0][3]).toEqual({ height: "400", hash: "~" });
    expect(legacy.mock.calls[0][2]).toBe(1);
    expect(res.next).toBe("i:300:AA");
  });

  it("starts the next page below the floor when this one filled exactly at it", async () => {
    party.mockResolvedValue({ txs: [ptx("500", "BB")], more: false, floor: 400, exactMovements: true });
    const res = await getCosmosAccountTxs(chain, addr, { limit: 1 });
    expect(legacy).not.toHaveBeenCalled();
    expect(res.next).toBe("i:400:~");
  });

  it("keeps walking tx_party while it has more", async () => {
    party.mockResolvedValue({ txs: [ptx("500", "BB")], more: true, floor: 400, exactMovements: true });
    const res = await getCosmosAccountTxs(chain, addr, { limit: 1 });
    expect(res.next).toBe("i4:500:BB");
  });

  it("follows an i4 cursor into tx_party and an i cursor into the old union", async () => {
    party.mockResolvedValue({ txs: [], more: false, floor: 1, exactMovements: true });
    await getCosmosAccountTxs(chain, addr, { cursor: "i4:500:BB" });
    expect(party.mock.calls[0][3]).toEqual({ height: "500", hash: "BB" });

    legacy.mockResolvedValue({ txs: [], more: false, since: "x", fromGenesis: false });
    await getCosmosAccountTxs(chain, addr, { cursor: "i:400:~" });
    expect(party).toHaveBeenCalledTimes(1);
    expect(legacy.mock.calls[0][3]).toEqual({ height: "400", hash: "~" });
  });
});
