-- Migration 013: Scan's validator page reads, each served by an index or a rollup (Scan request 2026-10-16, part A).
--
-- Measured on production (atomone-1, 10.8M blocks; DKCMC and NodesHub, first read / warm), before this file:
--   proposerStats        count + max(height) + max(time) by proposer_cons  2.8 s / 1.4 s   (heap fetch per proposed block)
--   blockCount           count(*) of the coverage window                   1.1 s           (every block, every time)
--   commissionEarned     transfer kind=commission JOIN tx by signer        14.4 s          (seq scan of transfer, NodesHub)
--   validatorEvents      tx by signer, msg_types LIKE '%suffix', newest     5.2 s / 0.9 s   (walked every tx by height, NodesHub)
--   validatorCreatedAt   tx by signer, MsgCreateValidator, oldest          1.1 s / 0.17 s  (every NodesHub tx, then a sort)
--   powerEvents flow30   staking_event by validator, last 30 days          2.1 s           (seq scan, NodesHub)
--   powerHistory         validator_power JOIN block for the time            0.17 s / 0.04 s (a block heap visit per row)
--   signing counts/runs  missed_signature by cons_addr                     0.13 s cold     (heap fetch for flag)
-- NodesHub's account has signed 47,187 transactions (a restake service), DKCMC's 62: every "by signer" read that
-- scanned the signer's rows was fast for one and slow for the other. DKCMC has proposed 913,000 blocks, so even an
-- index-only count of them is 170 ms: that read gets a rollup instead.
--
-- Every build is CONCURRENTLY: the follower and Scan are never blocked. migrate.sh pipes statements in autocommit,
-- which CONCURRENTLY requires, and re-runs every file: IF NOT EXISTS / IF EXISTS and the guarded blocks below keep
-- this one idempotent and cheap to repeat. A replacement is built before the index it replaces is dropped, so no read
-- is ever without its index.

-- ── indexes ─────────────────────────────────────────────────────────────────

-- proposedBlocks, proposer_blocks() below, the fairness window: one proposer's blocks with their time, read from the
-- index alone. Replaces block_proposer_idx (same keys).
CREATE INDEX CONCURRENTLY IF NOT EXISTS block_proposer_time_idx
  ON block (chain_id, proposer_cons, height DESC) INCLUDE (time)
  WHERE proposer_cons IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS block_proposer_idx;

-- validatorEvents, validatorCreatedAt, every read by signer: the signer's transactions in height order, with the
-- message types in the index, so "newest 200 of these kinds" and "the first MsgCreateValidator" stop early and test
-- msg_types without a heap visit. Replaces tx_signer_idx (its keys are this one's prefix).
CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_signer_height_idx
  ON tx (chain_id, signer, height DESC) INCLUDE (msg_types)
  WHERE signer IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS tx_signer_idx;

-- validatorEvents: the commission a withdrawal moved, by transaction. Commission is under 0.1% of transfer rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transfer_commission_idx
  ON transfer (chain_id, tx_hash) INCLUDE (denom, amount, time)
  WHERE kind = 'commission';

-- powerEvents flow30: a validator's staking events by time, both sides of a redelegation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS staking_event_validator_time_idx
  ON staking_event (chain_id, validator, time DESC)
  WHERE validator IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS staking_event_validator_dst_time_idx
  ON staking_event (chain_id, validator_dst, time DESC)
  WHERE validator_dst IS NOT NULL;

-- signingHistory: absent/nil counts and runs from the index alone. Replaces missed_signature_validator_idx.
CREATE INDEX CONCURRENTLY IF NOT EXISTS missed_signature_cons_flag_idx
  ON missed_signature (chain_id, cons_addr, height DESC) INCLUDE (flag);
DROP INDEX CONCURRENTLY IF EXISTS missed_signature_validator_idx;

-- ── block_proposer_count: blocks per proposer per 10,000 heights ────────────
-- proposer_blocks(chain, cons_hex, lo, hi) counts a proposer's blocks in any height window exactly: whole buckets
-- from this table, the two partial ends (under 10,000 heights each) from block_proposer_time_idx, and the newest
-- block from that index too. All of atomone-1 is about 1,100 bucket rows per proposer, where counting DKCMC's
-- 913,000 blocks from the index alone took 170 ms.
--
-- Kept by the database, in the writer's own transaction, so every writer is counted (the follower, a refill, the
-- gno follower, gno-signatures, a hand repair). Statement-level triggers over the transition tables: an INSERT ...
-- ON CONFLICT puts only rows it really inserted in the INSERT table, so a refill rewriting a block counts nothing
-- twice; an update (a refill filling a proposer an older extractor left empty) moves the count; a delete takes it off.
-- A bucket row exists only while it counts at least one block. Rows are upserted in key order so two writers cannot
-- deadlock on them.
CREATE TABLE IF NOT EXISTS block_proposer_count (
  chain_id      text   NOT NULL,
  proposer_cons text   NOT NULL,
  bucket        bigint NOT NULL,   -- height / 10000
  blocks        int    NOT NULL,
  PRIMARY KEY (chain_id, proposer_cons, bucket)
);

CREATE OR REPLACE FUNCTION block_proposer_count_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO block_proposer_count AS c (chain_id, proposer_cons, bucket, blocks)
  SELECT chain_id, proposer_cons, height / 10000, count(*)
    FROM new_rows WHERE proposer_cons IS NOT NULL
   GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  ON CONFLICT (chain_id, proposer_cons, bucket) DO UPDATE SET blocks = c.blocks + EXCLUDED.blocks;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION block_proposer_count_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO block_proposer_count AS c (chain_id, proposer_cons, bucket, blocks)
  SELECT chain_id, proposer_cons, bucket, sum(d)
    FROM (SELECT chain_id, proposer_cons, height / 10000 AS bucket, -1 AS d FROM old_rows WHERE proposer_cons IS NOT NULL
          UNION ALL
          SELECT chain_id, proposer_cons, height / 10000, 1 FROM new_rows WHERE proposer_cons IS NOT NULL) x
   GROUP BY 1, 2, 3 HAVING sum(d) <> 0 ORDER BY 1, 2, 3
  ON CONFLICT (chain_id, proposer_cons, bucket) DO UPDATE SET blocks = c.blocks + EXCLUDED.blocks;
  DELETE FROM block_proposer_count c
   USING (SELECT DISTINCT chain_id, proposer_cons, height / 10000 AS bucket FROM old_rows WHERE proposer_cons IS NOT NULL) o
   WHERE c.chain_id = o.chain_id AND c.proposer_cons = o.proposer_cons AND c.bucket = o.bucket AND c.blocks <= 0;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION block_proposer_count_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE block_proposer_count c SET blocks = c.blocks - o.n
    FROM (SELECT chain_id, proposer_cons, height / 10000 AS bucket, count(*) AS n
            FROM old_rows WHERE proposer_cons IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3) o
   WHERE c.chain_id = o.chain_id AND c.proposer_cons = o.proposer_cons AND c.bucket = o.bucket;
  DELETE FROM block_proposer_count c
   USING (SELECT DISTINCT chain_id, proposer_cons, height / 10000 AS bucket FROM old_rows WHERE proposer_cons IS NOT NULL) o
   WHERE c.chain_id = o.chain_id AND c.proposer_cons = o.proposer_cons AND c.bucket = o.bucket AND c.blocks <= 0;
  RETURN NULL;
END $$;

-- The triggers and a count from scratch, together and once: block is locked against writers (they wait about ten
-- seconds, then carry on counted by the trigger) so nothing lands between the count and the trigger taking over.
-- Later runs of this file find the trigger and skip the recount.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'block'::regclass AND tgname = 'block_proposer_count_ins') THEN
    PERFORM set_config('work_mem', '256MB', true);
    LOCK TABLE block IN SHARE ROW EXCLUSIVE MODE;
    CREATE TRIGGER block_proposer_count_ins AFTER INSERT ON block
      REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION block_proposer_count_ins();
    CREATE TRIGGER block_proposer_count_upd AFTER UPDATE ON block
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION block_proposer_count_upd();
    CREATE TRIGGER block_proposer_count_del AFTER DELETE ON block
      REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION block_proposer_count_del();
    DELETE FROM block_proposer_count;
    INSERT INTO block_proposer_count (chain_id, proposer_cons, bucket, blocks)
    SELECT chain_id, proposer_cons, height / 10000, count(*)
      FROM block WHERE proposer_cons IS NOT NULL
     GROUP BY 1, 2, 3;
  END IF;
END $$;

-- Exact for any window, and fast for every one: at most two partial buckets are counted from the index.
CREATE OR REPLACE FUNCTION proposer_blocks(p_chain text, p_cons text, p_lo bigint, p_hi bigint)
RETURNS TABLE (blocks bigint, last_height bigint, last_time timestamptz)
LANGUAGE sql STABLE AS $$
  WITH w AS (SELECT (p_lo + 9999) / 10000 AS b_lo,      -- first bucket that starts inside the window
                    (p_hi + 1) / 10000 - 1 AS b_hi)     -- last bucket that ends inside it
  SELECT CASE WHEN w.b_lo > w.b_hi THEN
           (SELECT count(*) FROM block b
             WHERE b.chain_id = p_chain AND b.proposer_cons = p_cons AND b.height BETWEEN p_lo AND p_hi)
         ELSE
           COALESCE((SELECT sum(c.blocks) FROM block_proposer_count c
                      WHERE c.chain_id = p_chain AND c.proposer_cons = p_cons AND c.bucket BETWEEN w.b_lo AND w.b_hi), 0)
           + (SELECT count(*) FROM block b
               WHERE b.chain_id = p_chain AND b.proposer_cons = p_cons AND b.height >= p_lo AND b.height < w.b_lo * 10000)
           + (SELECT count(*) FROM block b
               WHERE b.chain_id = p_chain AND b.proposer_cons = p_cons AND b.height >= (w.b_hi + 1) * 10000 AND b.height <= p_hi)
         END::bigint,
         l.height, l.time
    FROM w
    LEFT JOIN LATERAL (SELECT b.height, b.time FROM block b
                        WHERE b.chain_id = p_chain AND b.proposer_cons = p_cons AND b.height BETWEEN p_lo AND p_hi
                        ORDER BY b.height DESC LIMIT 1) l ON true
$$;
GRANT EXECUTE ON FUNCTION proposer_blocks(text, text, bigint, bigint) TO scan_ro;

-- ── transfer.signer: who signed the transaction a commission row came from ──
-- commissionEarned joined every commission row to tx to match the signer: a nested loop over all of a busy signer's
-- transactions (NodesHub 0.8 s cold), or a scan of transfer. The signer now sits on the row, set by the database
-- when the row is written: tx is written before transfer in the same transaction, and a transaction's transfers are
-- always replaced together after it, so the copy cannot go stale. Commission rows only (about 0.1% of transfer);
-- every other row keeps it NULL. A transaction with no known signer leaves it NULL, as the join matched nothing.
-- Adding the column is a catalogue change (no rewrite), skipped once it exists so later runs take no lock at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'transfer'::regclass AND attname = 'signer' AND NOT attisdropped) THEN
    PERFORM set_config('lock_timeout', '10s', true);
    ALTER TABLE transfer ADD COLUMN signer text;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION transfer_commission_signer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT x.signer INTO NEW.signer FROM tx x WHERE x.chain_id = NEW.chain_id AND x.hash = NEW.tx_hash;
  RETURN NEW;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'transfer'::regclass AND tgname = 'transfer_commission_signer') THEN
    CREATE TRIGGER transfer_commission_signer BEFORE INSERT ON transfer
      FOR EACH ROW WHEN (NEW.kind = 'commission') EXECUTE FUNCTION transfer_commission_signer();
  END IF;
END $$;

-- The rows already there. Re-runs find only rows whose transaction has no signer, through the index below.
UPDATE transfer t SET signer = x.signer
  FROM tx x
 WHERE t.kind = 'commission' AND t.signer IS NULL
   AND x.chain_id = t.chain_id AND x.hash = t.tx_hash AND x.signer IS NOT NULL;

-- commissionEarned from the index alone: sum, count, first and last per denom.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transfer_commission_signer_idx
  ON transfer (chain_id, signer) INCLUDE (denom, amount, time)
  WHERE kind = 'commission';

-- ── validator_power.time: the block time of each change ─────────────────────
-- powerHistory joined block for the time, a heap visit per point (2,000 points: 0.3 s cold). Set from block when the
-- row is written (block is written first in the same transaction); a block's time never changes, so an upsert of
-- the power alone keeps it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'validator_power'::regclass AND attname = 'time' AND NOT attisdropped) THEN
    PERFORM set_config('lock_timeout', '10s', true);
    ALTER TABLE validator_power ADD COLUMN time timestamptz;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validator_power_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT b.time INTO NEW.time FROM block b WHERE b.chain_id = NEW.chain_id AND b.height = NEW.height;
  RETURN NEW;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'validator_power'::regclass AND tgname = 'validator_power_time') THEN
    CREATE TRIGGER validator_power_time BEFORE INSERT ON validator_power
      FOR EACH ROW WHEN (NEW.time IS NULL) EXECUTE FUNCTION validator_power_time();
  END IF;
END $$;

UPDATE validator_power vp SET time = b.time
  FROM block b
 WHERE vp.time IS NULL AND b.chain_id = vp.chain_id AND b.height = vp.height;

-- powerHistory and the power before the window from the index alone. Replaces validator_power_cons_idx.
CREATE INDEX CONCURRENTLY IF NOT EXISTS validator_power_cons_time_idx
  ON validator_power (chain_id, cons_addr, height DESC) INCLUDE (power, time);
DROP INDEX CONCURRENTLY IF EXISTS validator_power_cons_idx;

-- ── capabilities ────────────────────────────────────────────────────────────
-- Each covers what its source covers: the rollup every block, the two copied columns their table's rows.
INSERT INTO extract_capability (name, min_version, description) VALUES
  ('proposer_count',       0, 'proposer_blocks(): a proposer''s blocks in any height window, from block_proposer_count'),
  ('commission_signer',    4, 'transfer.signer on commission rows: the signer of the withdrawing transaction'),
  ('validator_power_time', 4, 'validator_power.time: the block time of each power change')
ON CONFLICT (name) DO UPDATE SET min_version = EXCLUDED.min_version, description = EXCLUDED.description;

-- ── Scan's role: no JIT ─────────────────────────────────────────────────────
-- Scan's reads are short index lookups. When the planner overestimates one (NodesHub's 30-day flow: 139,000 rows
-- expected, 758 read) its cost crosses jit_above_cost and LLVM compiles the plan: 16 to 290 ms spent before a 5 ms
-- read. Applies to scan_ro's new connections, to this database only: a role is cluster-wide, so a plain ALTER ROLE
-- run against a test database would change production too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scan_ro') THEN
    EXECUTE format('ALTER ROLE scan_ro IN DATABASE %I SET jit = off', current_database());
  END IF;
END $$;
