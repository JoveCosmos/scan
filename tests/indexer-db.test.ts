import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool, commitBatch, readCursor, resolveUnjails, recordGaps, heartbeat } from "../indexer/src/db";
import { extractBlock, type ExtractedBlock } from "../indexer/src/extract";
import type { Pool } from "pg";

/**
 * Exercises the real database, so it only runs where one exists.
 *
 * Set INDEXER_TEST_DATABASE_URL to a throwaway Postgres and these run; without
 * it they skip, so `npm test` stays green on a laptop with no container. The
 * schema in indexer/sql must already be applied.
 *
 *   INDEXER_TEST_DATABASE_URL=postgres://indexer:pw@127.0.0.1:5433/gata_indexer \
 *     npx vitest run tests/indexer-db.test.ts
 */
const url = process.env.INDEXER_TEST_DATABASE_URL;
const CHAIN = "test-chain-1";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

function sampleBlock(): ExtractedBlock {
  return extractBlock(
    fixture("atomone-block-9823288.json"),
    fixture("atomone-block-results-9823288.json")
  )!;
}

describe.skipIf(!url)("indexer database", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(url!);
    // A clean slate, scoped to this fake chain id so a real database is safe.
    await pool.query("DELETE FROM transfer WHERE chain_id = $1", [CHAIN]);
    await pool.query("DELETE FROM tx WHERE chain_id = $1", [CHAIN]);
    await pool.query("DELETE FROM block WHERE chain_id = $1", [CHAIN]);
    await pool.query("DELETE FROM indexer_cursor WHERE chain_id = $1", [CHAIN]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("starts with no cursor", async () => {
    expect(await readCursor(pool, CHAIN)).toBeNull();
  });

  it("writes a block, its txs and transfers, and advances the cursor", async () => {
    const b = sampleBlock();
    await commitBatch(pool, CHAIN, [b]);

    expect(await readCursor(pool, CHAIN)).toBe(9823288);

    const txs = await pool.query("SELECT * FROM tx WHERE chain_id = $1", [CHAIN]);
    expect(txs.rowCount).toBe(1);
    expect(txs.rows[0].fee_denom).toBe("uphoton");
    // numeric comes back as a string, which is the point — no float rounding.
    expect(txs.rows[0].fee_amount).toBe("220335");
    expect(txs.rows[0].msg_types).toHaveLength(4);

    const transfers = await pool.query(
      "SELECT * FROM transfer WHERE chain_id = $1",
      [CHAIN]
    );
    expect(transfers.rowCount).toBe(b.transfers.length);
  });

  it("is idempotent — replaying a height changes nothing", async () => {
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM transfer WHERE chain_id = $1",
      [CHAIN]
    );

    // Crash recovery replays heights, so this must not duplicate or error.
    await commitBatch(pool, CHAIN, [sampleBlock()]);
    await commitBatch(pool, CHAIN, [sampleBlock()]);

    const after = await pool.query(
      "SELECT count(*)::int AS n FROM transfer WHERE chain_id = $1",
      [CHAIN]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const blocks = await pool.query(
      "SELECT count(*)::int AS n FROM block WHERE chain_id = $1",
      [CHAIN]
    );
    expect(blocks.rows[0].n).toBe(1);
  });

  it("never moves the cursor backwards", async () => {
    // An out-of-order batch must not rewind progress and strand later heights.
    const older = sampleBlock();
    older.block.height = "1000";
    older.txs = [];
    older.transfers = [];
    await commitBatch(pool, CHAIN, [older]);

    expect(await readCursor(pool, CHAIN)).toBe(9823288);
  });

  it("stores amounts wide enough for any Cosmos supply", async () => {
    // 78 digits: far beyond what a double could hold exactly.
    const huge = "123456789012345678901234567890";
    const b = sampleBlock();
    b.block.height = "9823289";
    b.txs = [];
    b.transfers = [
      {
        txHash: "WIDE",
        eventSeq: 0,
        authzMsgIndex: null,
        msgIndex: 0,
        coinIndex: 0,
        height: "9823289",
        time: b.block.time,
        kind: "transfer",
        fromAddr: "a",
        toAddr: "b",
        denom: "uatone",
        amount: huge,
      },
    ];
    await commitBatch(pool, CHAIN, [b]);

    const res = await pool.query(
      "SELECT amount FROM transfer WHERE chain_id = $1 AND tx_hash = 'WIDE'",
      [CHAIN]
    );
    expect(res.rows[0].amount).toBe(huge);
  });
});

describe.skipIf(!url)("vote and slash writes", () => {
  let pool: Pool;
  const CH = "vote-order-test";

  const voteRow = (height: string, option: string): ExtractedBlock => ({
    block: { height, time: "2026-01-01T00:00:00Z", proposerCons: null, hash: null, txCount: 0 },
    txs: [],
    transfers: [],
    votes: [
      {
        proposalId: "21",
        voter: "atone1voter",
        option,
        weighted: false,
        options: null,
        height,
        time: "2026-01-01T00:00:00Z",
        txHash: `HASH${height}`,
        eventSeq: 0,
      },
    ],
    slashes: [],
    missed: [],
    txParties: [],
    txMsgs: [],
    ibcPackets: [],
    stakingEvents: [],
    validatorPower: [],
    govDeposits: [],
    govProposals: [],
    validatorKeys: [],
    abciResultsMissing: false,
    extractVersion: 4,
  });

  beforeAll(async () => {
    pool = createPool(url!);
    for (const t of ["vote", "slash_event", "block"]) {
      await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [CH]);
    }
  });

  afterAll(async () => {
    for (const t of ["vote", "slash_event", "block"]) {
      await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [CH]);
    }
    await pool.end();
  });

  it("keeps a voter's latest vote when a recast arrives", async () => {
    await commitBatch(pool, CH, [voteRow("100", "VOTE_OPTION_NO")]);
    await commitBatch(pool, CH, [voteRow("200", "VOTE_OPTION_YES")]);

    const res = await pool.query(
      "SELECT option, height FROM vote WHERE chain_id=$1 AND voter='atone1voter'",
      [CH]
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].option).toBe("VOTE_OPTION_YES");
  });

  it("does NOT let an earlier vote overwrite a later one", async () => {
    // The hazard: backfill descends, so it meets height 50 *after* height 200.
    // Without the height guard this silently replaces a final vote with a
    // superseded one, and nothing would ever report an error.
    await commitBatch(pool, CH, [voteRow("50", "VOTE_OPTION_ABSTAIN")]);

    const res = await pool.query(
      "SELECT option, height FROM vote WHERE chain_id=$1 AND voter='atone1voter'",
      [CH]
    );
    expect(res.rows[0].option).toBe("VOTE_OPTION_YES");
    expect(Number(res.rows[0].height)).toBe(200);
  });

  it("writes slash and jail rows from a real block, idempotently", async () => {
    const slash = extractBlock(
      fixture("atomone-block-9829661.json"),
      fixture("atomone-block-results-9829661.json")
    )!;

    await commitBatch(pool, CH, [slash]);
    await commitBatch(pool, CH, [slash]); // replay must not duplicate

    const res = await pool.query(
      "SELECT kind, reason, burned FROM slash_event WHERE chain_id=$1 ORDER BY kind",
      [CH]
    );
    expect(res.rows.map((r) => r.kind)).toEqual(["jailed", "slashed"]);
    expect(res.rows[1].reason).toBe("downtime");
    expect(res.rows[1].burned).toBe("4812300");
  });

  it("counts jailings per validator, which no node can answer", async () => {
    const res = await pool.query(
      `SELECT count(*)::int AS times FROM slash_event
       WHERE chain_id=$1 AND kind='jailed'
         AND cons_addr='atonevalcons1surx4dn7pqz8akv8nqmwtky7e7rsye92lrlpn4'`,
      [CH]
    );
    expect(res.rows[0].times).toBe(1);
  });
});

describe.skipIf(!url)("extract version 4 writes", () => {
  let pool: Pool;
  const CH = "v4-write-test";
  const TABLES = [
    "transfer", "tx", "block", "tx_party", "tx_msg", "staking_event", "validator_power",
    "slash_event", "validator_key", "ibc_packet", "gov_deposit", "gov_proposal", "indexer_cursor",
    "block_gap",
  ];
  const at = (h: number) =>
    extractBlock(
      fixture(`atomone-block-${h}.json`),
      fixture(`atomone-block-results-${h}.json`)
    )!;
  const count = async (table: string) =>
    Number((await pool.query(`SELECT count(*) FROM ${table} WHERE chain_id = $1`, [CH])).rows[0].count);

  beforeAll(async () => {
    pool = createPool(url!);
    for (const t of TABLES) await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [CH]);
  });

  afterAll(async () => {
    for (const t of TABLES) await pool.query(`DELETE FROM ${t} WHERE chain_id = $1`, [CH]);
    await pool.end();
  });

  it("keeps all 105 rows of a pre-upgrade authz batch, and rewriting changes nothing", async () => {
    await commitBatch(pool, CH, [at(9294803)], 9294803);
    expect(await count("transfer")).toBe(105);
    expect(await count("tx_msg")).toBe(27);
    expect(await count("staking_event")).toBe(26);
    const parties = await count("tx_party");

    await commitBatch(pool, CH, [at(9294803)], 9294803);
    expect(await count("transfer")).toBe(105);
    expect(await count("tx_party")).toBe(parties);
  });

  it("writes the tx metadata columns", async () => {
    const { rows } = await pool.query(
      "SELECT memo, signers, fee_coins, codespace FROM tx WHERE chain_id = $1", [CH]
    );
    expect(rows[0].signers).toEqual(["atone1vvumkjdmen9fsgu88zqv8eulpn79g4g0lner8s"]);
    expect(rows[0].fee_coins).toHaveLength(1);
  });

  it("records head_height alongside the cursor", async () => {
    const { rows } = await pool.query(
      "SELECT last_height, head_height FROM indexer_cursor WHERE chain_id = $1", [CH]
    );
    expect(rows[0]).toEqual({ last_height: "9294803", head_height: "9294803" });
  });

  it("merges a packet's send, ack and receive columns without erasing any", async () => {
    await commitBatch(pool, CH, [at(10524171), at(10524728), at(10524863)]);
    const { rows } = await pool.query(
      `SELECT direction, sequence::text, send_height::text, ack_height::text, ack_ok, recv_height::text
         FROM ibc_packet WHERE chain_id = $1 ORDER BY direction, sequence`, [CH]
    );
    expect(rows).toEqual([
      { direction: "in", sequence: "59069", send_height: null, ack_height: null, ack_ok: null, recv_height: "10524863" },
      { direction: "out", sequence: "114476", send_height: null, ack_height: "10524171", ack_ok: true, recv_height: null },
      { direction: "out", sequence: "114477", send_height: "10524728", ack_height: null, ack_ok: null, recv_height: null },
    ]);
  });

  it("keeps a proposal's submission when its outcome arrives, in either order", async () => {
    await commitBatch(pool, CH, [at(9463929)]);
    await commitBatch(pool, CH, [at(9148971)]);
    const { rows } = await pool.query(
      "SELECT submit_height::text, outcome, outcome_height::text, messages FROM gov_proposal WHERE chain_id = $1", [CH]
    );
    expect(rows).toEqual([
      {
        submit_height: "9148971",
        outcome: "passed",
        outcome_height: "9463929",
        messages: ["/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade"],
      },
    ]);
    expect(await count("gov_deposit")).toBe(1);
  });

  it("stores the tombstone of a double sign", async () => {
    await commitBatch(pool, CH, [at(1663342)]);
    const { rows } = await pool.query(
      "SELECT kind FROM slash_event WHERE chain_id = $1 AND height = 1663342 ORDER BY kind", [CH]
    );
    expect(rows.map((r) => r.kind)).toEqual(["slashed", "tombstoned"]);
  });

  it("resolves an unjail to the consensus address once the key is known", async () => {
    await commitBatch(pool, CH, [at(9968835)]);
    const op = "atonevaloper10nnweapu0gqyj0zzw45w7vg58yc4aagwkmnx7x";
    const before = await pool.query(
      "SELECT cons_addr FROM slash_event WHERE chain_id = $1 AND kind = 'unjailed'", [CH]
    );
    expect(before.rows).toEqual([{ cons_addr: op }]);

    await pool.query(
      `INSERT INTO validator_key (chain_id, operator, cons_hex, cons_valcons)
       VALUES ($1, $2, 'ABCDEF', 'atonevalcons1test')`, [CH, op]
    );
    expect(await resolveUnjails(pool, CH)).toBe(1);
    const after = await pool.query(
      "SELECT cons_addr, operator FROM slash_event WHERE chain_id = $1 AND kind = 'unjailed'", [CH]
    );
    expect(after.rows).toEqual([{ cons_addr: "atonevalcons1test", operator: op }]);
  });

  it("writes a hollow block at version 0 and never over a good one", async () => {
    const good = at(9515610);
    const hollow = extractBlock(fixture("atomone-block-9515610.json"), {
      result: { height: "9515610", txs_results: null },
    })!;
    expect(hollow.extractVersion).toBe(0);

    await commitBatch(pool, CH, [hollow]);
    const v0 = await pool.query("SELECT extract_version FROM block WHERE chain_id = $1 AND height = 9515610", [CH]);
    expect(v0.rows[0].extract_version).toBe(0);

    await commitBatch(pool, CH, [good]);
    await commitBatch(pool, CH, [hollow]);
    const v4 = await pool.query("SELECT extract_version FROM block WHERE chain_id = $1 AND height = 9515610", [CH]);
    expect(v4.rows[0].extract_version).toBe(4);
    const t = await pool.query(
      "SELECT kind FROM transfer WHERE chain_id = $1 AND height = 9515610 ORDER BY event_seq", [CH]
    );
    expect(t.rows.map((r) => r.kind)).toEqual(["fee", "transfer"]);
  });

  it("records and clears gaps", async () => {
    await recordGaps(pool, CH, [5, 6, 7, 9], "fetch");
    const g = await pool.query("SELECT lo::int, hi::int FROM block_gap WHERE chain_id = $1 ORDER BY lo", [CH]);
    expect(g.rows).toEqual([{ lo: 5, hi: 7 }, { lo: 9, hi: 9 }]);
  });

  it("heartbeats only a cursor that is at the head", async () => {
    const before = (await pool.query("SELECT updated_at FROM indexer_cursor WHERE chain_id = $1", [CH])).rows[0].updated_at;
    await heartbeat(pool, CH, 99_999_999);
    const same = (await pool.query("SELECT updated_at FROM indexer_cursor WHERE chain_id = $1", [CH])).rows[0].updated_at;
    expect(same).toEqual(before);
    await heartbeat(pool, CH, 9294803);
    const moved = (await pool.query("SELECT updated_at FROM indexer_cursor WHERE chain_id = $1", [CH])).rows[0].updated_at;
    expect(moved.getTime()).toBeGreaterThan(before.getTime());
  });
});
