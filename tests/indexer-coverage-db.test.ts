import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

/**
 * coverage() against a real database.
 *
 * Split from the pure `covers` tests because this one needs Postgres: set
 * INDEXER_TEST_DATABASE_URL and it runs, otherwise it skips.
 *
 *   INDEXER_TEST_DATABASE_URL=postgres://indexer:pw@127.0.0.1:5433/gata_indexer \
 *     npx vitest run tests/indexer-coverage-db.test.ts
 *
 * Worth having as a database test rather than a mocked one: the query it
 * replaced aliased two columns `AS from` and `AS to`, which are reserved words
 * and a syntax error. Because the caller swallows errors and falls back to the
 * live path, that failure was completely silent - the indexer would simply
 * never have been used. Nothing short of executing the SQL would have found it.
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;

const chains: string[] = [];
let pool: Pool;
let coverage: (chainId: string, capability?: "blocks" | "fees" | "votes" | "slashing") => Promise<unknown>;
let slashHistory: (
  chainId: string,
  consAddr: string
) => Promise<{ events: { height: number; kind: string }[] } | null>;
let accountTxs: (
  chainId: string,
  address: string,
  limit?: number
) => Promise<{ txs: { hash: string }[]; more: boolean } | null>;
let proposerStats: (
  chainId: string,
  proposerCons: string
) => Promise<{
  proposed: number;
  totalBlocks: number;
  lastHeight: number | null;
} | null>;

/** A distinct chain per case, so the 30s coverage cache cannot leak between them. */
function chainId(name: string): string {
  const id = `cov-${name}-${Date.now()}`;
  chains.push(id);
  return id;
}

/** Blocks at one-minute spacing, written straight in so extract_version is ours to choose. */
async function seed(
  chain: string,
  rows: { height: number; version: number; proposer?: string }[]
): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO block (chain_id, height, time, tx_count, extract_version,
                          proposer_cons)
       VALUES ($1, $2, to_timestamp($3), 0, $4, $5)`,
      [
        chain,
        r.height,
        1_760_000_000 + r.height * 60,
        r.version,
        r.proposer ?? null,
      ]
    );
  }
}

/** Slash events for one consensus address. */
async function seedSlashes(
  chain: string,
  cons: string,
  rows: { height: number; kind: string; reason?: string }[]
): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO slash_event (chain_id, height, time, cons_addr, kind, reason)
       VALUES ($1, $2, to_timestamp($3), $4, $5, $6)`,
      [chain, r.height, 1_760_000_000 + r.height * 60, cons, r.kind, r.reason ?? null]
    );
  }
}

// File level, not per-describe. The pool is memoised on the module, so there is
// one for the whole file; closing it in the first describe's afterAll left the
// later ones querying a pool that had already been ended.
beforeAll(async () => {
  if (!url) return;
  // Set before the module is imported: the pool is built on first use.
  process.env.INDEXER_DATABASE_URL = url;
  const mod = await import("@/lib/indexer-db");
  coverage = mod.coverage;
  slashHistory = mod.slashHistory;
  proposerStats = mod.proposerStats;
  accountTxs = mod.accountTxsFromIndexer;
  pool = mod.indexerPool()!;
});

afterAll(async () => {
  if (!url) return;
  for (const c of chains) {
    await pool.query("DELETE FROM transfer WHERE chain_id = $1", [c]);
    await pool.query("DELETE FROM tx WHERE chain_id = $1", [c]);
    await pool.query("DELETE FROM slash_event WHERE chain_id = $1", [c]);
    await pool.query("DELETE FROM block WHERE chain_id = $1", [c]);
  }
  await pool.end();
});

describe.skipIf(!url)("coverage", () => {

  it("spans everything when every block is fully extracted", async () => {
    const chain = chainId("full");
    await seed(chain, [
      { height: 100, version: 2 },
      { height: 101, version: 2 },
      { height: 102, version: 2 },
    ]);

    expect(await coverage(chain)).toMatchObject({ lowest: 100, highest: 102 });
  });

  it("stops below the first block an older extractor wrote", async () => {
    // The shape of the real failure: a follower wrote the top of the range
    // before votes were extracted, so those blocks exist but hold no votes.
    const chain = chainId("stale-top");
    await seed(chain, [
      { height: 200, version: 2 },
      { height: 201, version: 2 },
      { height: 202, version: 0 },
      { height: 203, version: 0 },
    ]);

    // Asked for a capability those older blocks lack (votes, version 2).
    expect(await coverage(chain, "votes")).toMatchObject({ lowest: 200, highest: 201 });
  });

  it("covers only the run that carries the capability, ending at the newest", async () => {
    // Version 4 contract: indexer_coverage returns the contiguous run, ending
    // at the newest block that carries the capability, in which every block
    // carries it. The older block below is outside that run.
    const chain = chainId("stale-bottom");
    await seed(chain, [
      { height: 300, version: 0 },
      { height: 301, version: 2 },
    ]);

    expect(await coverage(chain, "votes")).toMatchObject({ lowest: 301, highest: 301 });
  });

  it("returns null for a chain it holds nothing for", async () => {
    expect(await coverage(chainId("empty"))).toBeNull();
  });
});

describe.skipIf(!url)("slashHistory", () => {
  const CONS = "atonevalcons1test";

  it("returns a validator's events, most recent first", async () => {
    const chain = chainId("slash-order");
    await seed(chain, [
      { height: 400, version: 2 },
      { height: 401, version: 2 },
      { height: 402, version: 2 },
    ]);
    await seedSlashes(chain, CONS, [
      { height: 400, kind: "jailed", reason: "downtime" },
      { height: 402, kind: "unjailed" },
    ]);

    const history = await slashHistory(chain, CONS);
    expect(history?.events.map((e) => e.height)).toEqual([402, 400]);
  });

  it("ignores another validator's events", async () => {
    const chain = chainId("slash-other");
    await seed(chain, [{ height: 500, version: 2 }]);
    await seedSlashes(chain, "atonevalcons1someone-else", [
      { height: 500, kind: "jailed" },
    ]);

    expect(await slashHistory(chain, CONS)).toMatchObject({ events: [] });
  });

  it("excludes events above the extraction ceiling", async () => {
    // The jailing at 602 sits in a block written by an older extractor. Its row
    // only exists because a later build happened to see it; counting it would
    // report a total from a range we cannot vouch for.
    const chain = chainId("slash-stale");
    await seed(chain, [
      { height: 600, version: 2 },
      { height: 601, version: 2 },
      { height: 602, version: 0 },
    ]);
    await seedSlashes(chain, CONS, [
      { height: 600, kind: "jailed" },
      { height: 602, kind: "jailed" },
    ]);

    const history = await slashHistory(chain, CONS);
    expect(history?.events.map((e) => e.height)).toEqual([600]);
  });

  it("refuses rather than reporting zero when nothing is covered", async () => {
    // "Never jailed" and "we have no idea" must not render as the same thing.
    const chain = chainId("slash-uncovered");
    await seed(chain, [{ height: 700, version: 0 }]);
    await seedSlashes(chain, CONS, [{ height: 700, kind: "jailed" }]);

    expect(await slashHistory(chain, CONS)).toBeNull();
  });
});

describe.skipIf(!url)("proposerStats", () => {
  it("counts blocks proposed against the chain total", async () => {
    // Uppercase hex, which is how CometBFT renders a proposer address and what
    // the indexer stores verbatim. Matching on any other encoding would return
    // zero for every validator and look like data rather than a bug.
    const mine = "D1EFF2308733A0EA52290132C2B5F19336470E06";
    const other = "C0156DC51958E6B0A858D54C7D2990077D95110B";
    const chain = chainId("proposer");
    await seed(chain, [
      { height: 800, version: 2, proposer: mine },
      { height: 801, version: 2, proposer: other },
      { height: 802, version: 2, proposer: mine },
      { height: 803, version: 2, proposer: other },
    ]);

    const stats = await proposerStats(chain, mine);
    expect(stats).toMatchObject({
      proposed: 2,
      totalBlocks: 4,
      lastHeight: 802,
    });
  });

  it("counts every written block, hollow ones included", async () => {
    // Proposer stats need only the block row ("blocks", min version 0): a
    // hollow block (no ABCI results) still has a real proposer.
    const mine = "AABBCCDDEEFF00112233445566778899AABBCCDD";
    const chain = chainId("proposer-stale");
    await seed(chain, [
      { height: 900, version: 2, proposer: mine },
      { height: 901, version: 0, proposer: mine },
    ]);

    expect(await proposerStats(chain, mine)).toMatchObject({
      proposed: 2,
      totalBlocks: 2,
    });
  });
});

/** A transaction, and optionally the value it moved. */
async function seedTx(
  chain: string,
  tx: { hash: string; height: number; signer?: string },
  transfers: { from?: string; to?: string; amount?: string; kind?: string }[] = []
): Promise<void> {
  await pool.query(
    `INSERT INTO tx (chain_id, hash, height, tx_index, time, code, signer, msg_types)
     VALUES ($1, $2, $3, 0, to_timestamp($4), 0, $5, '{}')`,
    [chain, tx.hash, tx.height, 1_760_000_000 + tx.height * 60, tx.signer ?? null]
  );
  let i = 0;
  for (const t of transfers) {
    await pool.query(
      `INSERT INTO transfer (chain_id, tx_hash, msg_index, coin_index, height,
                             time, kind, from_addr, to_addr, denom, amount)
       VALUES ($1, $2, $3, 0, $4, to_timestamp($5), $6, $7, $8, 'uatone', $9)`,
      [
        chain,
        tx.hash,
        i++,
        tx.height,
        1_760_000_000 + tx.height * 60,
        t.kind ?? "transfer",
        t.from ?? null,
        t.to ?? null,
        t.amount ?? "1000",
      ]
    );
  }
}

describe.skipIf(!url)("accountTxsFromIndexer", () => {
  const ME = "atone1me";
  const OTHER = "atone1other";

  it("finds transactions the account signed", async () => {
    const chain = chainId("acct-signed");
    await seed(chain, [{ height: 1000, version: 2 }]);
    await seedTx(chain, { hash: "AA", height: 1000, signer: ME });

    const res = await accountTxs(chain, ME);
    expect(res?.txs.map((t) => t.hash)).toEqual(["AA"]);
  });

  it("finds transactions that only sent value to the account", async () => {
    // Someone else signed and paid; this account is a recipient. A signer-only
    // query would miss every payment ever received.
    const chain = chainId("acct-received");
    await seed(chain, [{ height: 1100, version: 2 }]);
    await seedTx(chain, { hash: "BB", height: 1100, signer: OTHER }, [
      { from: OTHER, to: ME },
    ]);

    const res = await accountTxs(chain, ME);
    expect(res?.txs.map((t) => t.hash)).toEqual(["BB"]);
  });

  it("returns one row per transaction, not one per coin moved", async () => {
    // A multi-coin transfer must not appear three times in a list view.
    const chain = chainId("acct-multi");
    await seed(chain, [{ height: 1200, version: 2 }]);
    await seedTx(chain, { hash: "CC", height: 1200, signer: ME }, [
      { from: ME, to: OTHER },
      { from: ME, to: OTHER },
      { from: ME, to: OTHER },
    ]);

    const res = await accountTxs(chain, ME);
    expect(res?.txs).toHaveLength(1);
  });

  it("does not match on the fee alone", async () => {
    // Every signed transaction pays a fee to the collector. Matching fee-kind
    // transfers would make the collector a party to the entire chain.
    const chain = chainId("acct-fee");
    await seed(chain, [{ height: 1300, version: 2 }]);
    await seedTx(chain, { hash: "DD", height: 1300, signer: OTHER }, [
      { from: OTHER, to: ME, kind: "fee" },
    ]);

    expect(await accountTxs(chain, ME)).toMatchObject({ txs: [] });
  });

  it("orders newest first and reports there is more", async () => {
    const chain = chainId("acct-order");
    await seed(chain, [
      { height: 1400, version: 2 },
      { height: 1401, version: 2 },
      { height: 1402, version: 2 },
    ]);
    await seedTx(chain, { hash: "E1", height: 1400, signer: ME });
    await seedTx(chain, { hash: "E2", height: 1401, signer: ME });
    await seedTx(chain, { hash: "E3", height: 1402, signer: ME });

    const res = await accountTxs(chain, ME, 2);
    expect(res?.txs.map((t) => t.hash)).toEqual(["E3", "E2"]);
    expect(res?.more).toBe(true);
  });

  it("excludes transactions above the extraction ceiling", async () => {
    const chain = chainId("acct-stale");
    await seed(chain, [
      { height: 1500, version: 2 },
      { height: 1501, version: 0 },
    ]);
    await seedTx(chain, { hash: "F1", height: 1500, signer: ME });
    await seedTx(chain, { hash: "F2", height: 1501, signer: ME });

    const res = await accountTxs(chain, ME);
    expect(res?.txs.map((t) => t.hash)).toEqual(["F1"]);
  });
});
