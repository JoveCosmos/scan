-- gno.land in our own database, and a transaction count per address.
--
-- Scan read gno accounts from the upstream tx-indexer's GraphQL: no paging, no
-- address index (every query scans message fields across the chain), a silent
-- 10,000-row cap, no time on a transaction. A busy account (31k transactions)
-- had to be walked back from the head in height windows. This projects gno the
-- same way tx_party projects Cosmos chains: one row per (address, transaction),
-- keyset-paged on its primary key.
--
-- And Scan could page any history but not say "N transactions" without counting
-- it. address_tx_count keeps that count, exact over the heights written, in the
-- same transaction as the rows it counts.
--
-- Re-runnable. The count is rebuilt from scratch each time this file runs.

-- ── gno_tx: one row per transaction ──────────────────────────────────────────
-- hash is uppercase hex (the tx-indexer's base64, decoded), like tx.hash.
-- time is the block's. msg_types are the tx-indexer's message type names
-- (BankMsgSend, MsgCall, MsgRun, MsgAddPackage, MsgEnablePackage, MsgRejectPackage).
-- error is the chain's error text for a failed transaction.
CREATE TABLE IF NOT EXISTS gno_tx (
  chain_id   text          NOT NULL,
  hash       text          NOT NULL,
  height     bigint        NOT NULL,
  tx_index   int           NOT NULL,
  time       timestamptz   NOT NULL,
  success    boolean       NOT NULL,
  gas_wanted bigint,
  gas_used   bigint,
  fee_amount numeric(78,0),
  fee_denom  text,
  msg_types  text[]        NOT NULL DEFAULT '{}',
  memo       text,
  error      text,
  PRIMARY KEY (chain_id, hash)
);
CREATE INDEX IF NOT EXISTS gno_tx_height_idx ON gno_tx (chain_id, height DESC, tx_index);

-- ── gno_tx_party: who a gno transaction touched ─────────────────────────────
-- roles, sharing tx_party's bits where they mean the same: 1 signer (the
-- message's signer: from, caller, creator, approver), 8 sender (coins out: a
-- bank send's from, a call or run that sends coins, a Transfer event's from),
-- 16 recipient (a bank send's to, a Transfer event's to), 16384 creator (a
-- package's deployer). Transfer = GRC20 GnoEvents "Transfer" (from/to attrs) and
-- the bank's TransferEvent. A failed transaction's events are ignored.
CREATE TABLE IF NOT EXISTS gno_tx_party (
  chain_id text   NOT NULL,
  address  text   NOT NULL,
  height   bigint NOT NULL,
  tx_hash  text   NOT NULL,
  roles    int    NOT NULL,
  PRIMARY KEY (chain_id, address, height, tx_hash)
);

-- ── address_tx_count: an account's transactions, in one lookup ──────────────
-- tx_count is the number of distinct transactions the address is a party to
-- among the heights written at version 4 (tx_party for Cosmos chains,
-- gno_tx_party for gno), first/last the earliest and latest of them.
CREATE TABLE IF NOT EXISTS address_tx_count (
  chain_id     text        NOT NULL,
  address      text        NOT NULL,
  tx_count     bigint      NOT NULL,
  first_height bigint      NOT NULL,
  last_height  bigint      NOT NULL,
  first_time   timestamptz,
  last_time    timestamptz,
  PRIMARY KEY (chain_id, address)
);

INSERT INTO extract_capability (name, min_version, description) VALUES
  ('gno_tx',           4, 'gno_tx: gno transactions with time, fee, gas, types, success'),
  ('gno_tx_party',     4, 'gno_tx_party: every address party to a gno transaction, with roles'),
  ('address_tx_count', 4, 'address_tx_count: transactions per address over the covered party rows')
ON CONFLICT (name) DO UPDATE SET min_version = EXCLUDED.min_version, description = EXCLUDED.description;

-- ── counting on write ───────────────────────────────────────────────────────
-- Statement-level, over the transition table: an INSERT ... ON CONFLICT puts only
-- the rows it really inserted in it, so a refill rewriting a transaction's
-- parties counts nothing twice. Every writer - the follower, a refill, the gno
-- follower, a hand repair - is counted, because the database does it. first/
-- last times come from block, written earlier in the same transaction.
CREATE OR REPLACE FUNCTION address_tx_count_add() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO address_tx_count AS a (chain_id, address, tx_count, first_height, last_height, first_time, last_time)
  SELECT n.chain_id, n.address, n.c, n.lo, n.hi, bl.time, bh.time
    FROM (SELECT chain_id, address, count(*) AS c, min(height) AS lo, max(height) AS hi
            FROM new_rows GROUP BY chain_id, address) n
    LEFT JOIN block bl ON bl.chain_id = n.chain_id AND bl.height = n.lo
    LEFT JOIN block bh ON bh.chain_id = n.chain_id AND bh.height = n.hi
  ON CONFLICT (chain_id, address) DO UPDATE SET
    tx_count     = a.tx_count + EXCLUDED.tx_count,
    first_time   = CASE WHEN EXCLUDED.first_height < a.first_height THEN EXCLUDED.first_time ELSE a.first_time END,
    first_height = LEAST(a.first_height, EXCLUDED.first_height),
    last_time    = CASE WHEN EXCLUDED.last_height > a.last_height THEN EXCLUDED.last_time ELSE a.last_time END,
    last_height  = GREATEST(a.last_height, EXCLUDED.last_height);
  RETURN NULL;
END $$;

-- A delete (no writer does one today; a hand repair might) recounts each address
-- it touched from its party table, so the count stays exact rather than drifting.
CREATE OR REPLACE FUNCTION address_tx_count_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($q$
    WITH hit AS (SELECT DISTINCT chain_id, address FROM old_rows),
    now_ AS (
      SELECT h.chain_id, h.address, count(p.height) AS c, min(p.height) AS lo, max(p.height) AS hi
        FROM hit h LEFT JOIN %I p ON p.chain_id = h.chain_id AND p.address = h.address
       GROUP BY h.chain_id, h.address),
    gone AS (
      DELETE FROM address_tx_count a USING now_ n
       WHERE a.chain_id = n.chain_id AND a.address = n.address AND n.c = 0)
    UPDATE address_tx_count a SET tx_count = n.c, first_height = n.lo, last_height = n.hi,
           first_time = (SELECT time FROM block WHERE chain_id = n.chain_id AND height = n.lo),
           last_time  = (SELECT time FROM block WHERE chain_id = n.chain_id AND height = n.hi)
      FROM now_ n
     WHERE a.chain_id = n.chain_id AND a.address = n.address AND n.c > 0
  $q$, TG_TABLE_NAME);
  RETURN NULL;
END $$;

-- The triggers and a count from scratch, together: the party tables are locked
-- against writers (they wait, then carry on counted by the trigger) so nothing
-- lands between the recount and the trigger taking over.
BEGIN;
LOCK TABLE tx_party, gno_tx_party IN SHARE ROW EXCLUSIVE MODE;
CREATE OR REPLACE TRIGGER tx_party_count_add AFTER INSERT ON tx_party
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION address_tx_count_add();
CREATE OR REPLACE TRIGGER tx_party_count_del AFTER DELETE ON tx_party
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION address_tx_count_del();
CREATE OR REPLACE TRIGGER gno_tx_party_count_add AFTER INSERT ON gno_tx_party
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION address_tx_count_add();
CREATE OR REPLACE TRIGGER gno_tx_party_count_del AFTER DELETE ON gno_tx_party
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION address_tx_count_del();
DELETE FROM address_tx_count;
INSERT INTO address_tx_count (chain_id, address, tx_count, first_height, last_height, first_time, last_time)
SELECT n.chain_id, n.address, n.c, n.lo, n.hi, bl.time, bh.time
  FROM (SELECT chain_id, address, count(*) AS c, min(height) AS lo, max(height) AS hi FROM tx_party GROUP BY 1, 2
        UNION ALL
        SELECT chain_id, address, count(*), min(height), max(height) FROM gno_tx_party GROUP BY 1, 2) n
  LEFT JOIN block bl ON bl.chain_id = n.chain_id AND bl.height = n.lo
  LEFT JOIN block bh ON bh.chain_id = n.chain_id AND bh.height = n.hi;
COMMIT;

-- ── coverage: the run ends at the newest block that carries the capability ──
-- It used to end at the newest block of any version. gno-signatures writes
-- gnoland-1 blocks at version 3 as they are made, usually ahead of the follower,
-- and a version-3 block at the very top emptied every capability for gnoland-1
-- until the follower caught up. A block above the newest capable one is simply
-- not processed yet: coverage ends below it, and freshness (indexer_cursor)
-- says how far behind that is.
CREATE OR REPLACE FUNCTION indexer_coverage(p_chain text, p_capability text)
RETURNS TABLE (lo bigint, hi bigint, lo_time timestamptz, hi_time timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_min   smallint;
  v_hi    bigint;
  v_low   bigint;
  v_floor bigint;
  v_x     bigint;
  v       int;
BEGIN
  SELECT c.min_version INTO v_min FROM extract_capability c WHERE c.name = p_capability;
  IF v_min IS NULL THEN RETURN; END IF;

  -- The newest block at or above the capability's version (one probe per version).
  FOR v IN v_min .. 15 LOOP
    SELECT max(b.height) INTO v_x FROM block b WHERE b.chain_id = p_chain AND b.extract_version = v;
    v_hi := GREATEST(v_hi, v_x);
  END LOOP;
  IF v_hi IS NULL THEN RETURN; END IF;
  SELECT min(b.height) INTO v_low FROM block b WHERE b.chain_id = p_chain;

  -- The newest block below it written by an older extractor.
  FOR v IN 0 .. v_min - 1 LOOP
    SELECT max(b.height) INTO v_x FROM block b
     WHERE b.chain_id = p_chain AND b.extract_version = v AND b.height < v_hi;
    v_floor := GREATEST(v_floor, v_x);
  END LOOP;

  -- The newest hole.
  SELECT max(g.hi) INTO v_x FROM block_gap g WHERE g.chain_id = p_chain AND g.lo <= v_hi;
  v_floor := GREATEST(v_floor, v_x);

  lo := GREATEST(COALESCE(v_floor + 1, v_low), v_low);
  hi := v_hi;
  IF lo > hi THEN RETURN; END IF;
  SELECT b.time INTO lo_time FROM block b WHERE b.chain_id = p_chain AND b.height = lo;
  SELECT b.time INTO hi_time FROM block b WHERE b.chain_id = p_chain AND b.height = hi;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION indexer_coverage(text, text) TO scan_ro;
-- Default privileges already give scan_ro, monitor and app_ro SELECT on new tables.
