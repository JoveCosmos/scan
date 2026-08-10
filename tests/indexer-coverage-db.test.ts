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
 * live path, that failure was completely silent — the indexer would simply
 * never have been used. Nothing short of executing the SQL would have found it.
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;

const chains: string[] = [];
let pool: Pool;
let coverage: (chainId: string) => Promise<unknown>;
let slashHistory: (
  chainId: string,
  consAddr: string
) => Promise<{ events: { height: number; kind: string }[] } | null>;

/** A distinct chain per case, so the 30s coverage cache cannot leak between them. */
function chainId(name: string): string {
  const id = `cov-${name}-${Date.now()}`;
  chains.push(id);
  return id;
}

/** Blocks at one-minute spacing, written straight in so extract_version is ours to choose. */
async function seed(
  chain: string,
  rows: { height: number; version: number }[]
): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO block (chain_id, height, time, tx_count, extract_version)
       VALUES ($1, $2, to_timestamp($3), 0, $4)`,
      [chain, r.height, 1_760_000_000 + r.height * 60, r.version]
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
  pool = mod.indexerPool()!;
});

afterAll(async () => {
  if (!url) return;
  for (const c of chains) {
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

    expect(await coverage(chain)).toMatchObject({ lowest: 200, highest: 201 });
  });

  it("refuses everything when the lowest block is stale", async () => {
    // Nothing sits below the stale floor, so there is no range to vouch for.
    const chain = chainId("stale-bottom");
    await seed(chain, [
      { height: 300, version: 0 },
      { height: 301, version: 2 },
    ]);

    expect(await coverage(chain)).toBeNull();
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
