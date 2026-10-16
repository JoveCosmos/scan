-- Migration 014: gno.land messages and GRC20 tokens in our own database (Scan request 2026-10-16, part B).
--
-- Scan read both from the tx-indexer's GraphQL: 1-6 s a query, a 10,000-transaction cap, a negative "gt"
-- bound that returns nothing (so height 0 needs its own window), and every token's state rebuilt in memory at each
-- boot. Written by the gno follower at gno extract version 5, history by the gno refill (gno-refill-cli.ts);
-- readers gate on indexer_coverage(chain, 'gno_tx_msg') and indexer_coverage(chain, 'gno_grc20').
--
-- Re-runnable: IF NOT EXISTS everywhere, and the balance triggers (with a count from scratch) are created once.

-- ── gno_tx_msg: one row per message ─────────────────────────────────────────
-- kind: call (MsgCall), run (MsgRun), addpkg (MsgAddPackage), enable (MsgEnablePackage, a package approval), reject
-- (MsgRejectPackage), send (BankMsgSend). caller is the signer: caller, creator, approver, sender or from_address.
-- pkg_path is the realm called or the package added, approved or rejected; NULL for a send, and for a run unless its
-- transaction names its path (gnoland-1's never do: the chain assigns it).
-- func and args for a call only; each arg is cut to 200 characters (an ellipsis marks the cut). msg_index is the
-- message's place in the transaction. Failed transactions included (success false). Session messages
-- (create_session, revoke_session: the tx-indexer's UnexpectedMessage) have no row.
CREATE TABLE IF NOT EXISTS gno_tx_msg (
  chain_id  text    NOT NULL,
  tx_hash   text    NOT NULL,
  msg_index int     NOT NULL,
  height    bigint  NOT NULL,
  success   boolean NOT NULL,
  kind      text    NOT NULL,
  pkg_path  text,
  func      text,
  caller    text,
  args      text[],
  PRIMARY KEY (chain_id, tx_hash, msg_index)
);
-- A realm's calls, newest first, keyset-paged on (height, tx_hash, msg_index); kind in the index so a count of calls
-- (or approvals) reads the index alone.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_tx_msg_pkg_idx
  ON gno_tx_msg (chain_id, pkg_path, height DESC, tx_hash DESC, msg_index DESC) INCLUDE (kind);
-- An account's messages.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_tx_msg_caller_idx
  ON gno_tx_msg (chain_id, caller, height DESC);
-- Every package with its deployer.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_tx_msg_addpkg_idx
  ON gno_tx_msg (chain_id, pkg_path) INCLUDE (caller, height, tx_hash, success)
  WHERE kind = 'addpkg';

-- ── GRC20: tokens, transfers, balances ─────────────────────────────────────
-- From the GnoEvents of gno.land/p/nt/grc20/v0 (the package every GRC20 token is built on; GRC721 collections emit
-- a NewToken too, from their own package, and are not here): NewToken(token, name, symbol, decimals) and
-- Transfer(token, from, to, value). Successful transactions only.

-- token is the key the events carry, <realm>.<SYMBOL>.<sequence in hex>, e.g. gno.land/r/gnoswap/gns.GNS.0000000;
-- realm is what is left of it.
CREATE TABLE IF NOT EXISTS gno_grc20_token (
  chain_id       text   NOT NULL,
  token          text   NOT NULL,
  realm          text,
  name           text,
  symbol         text,
  decimals       int,
  created_height bigint NOT NULL,
  created_tx     text   NOT NULL,
  PRIMARY KEY (chain_id, token)
);

-- A mint has from_addr '', a burn to_addr ''. event_index is the event's place in the transaction.
CREATE TABLE IF NOT EXISTS gno_grc20_transfer (
  chain_id    text          NOT NULL,
  height      bigint        NOT NULL,
  tx_hash     text          NOT NULL,
  event_index int           NOT NULL,
  token       text          NOT NULL,
  from_addr   text          NOT NULL,
  to_addr     text          NOT NULL,
  amount      numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, event_index)
);
-- A token's transfers and an account's (both sides), newest first, keyset-paged on (height, tx_hash, event_index).
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_grc20_transfer_token_idx
  ON gno_grc20_transfer (chain_id, token, height DESC, tx_hash DESC, event_index DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_grc20_transfer_from_idx
  ON gno_grc20_transfer (chain_id, from_addr, height DESC, tx_hash DESC, event_index DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_grc20_transfer_to_idx
  ON gno_grc20_transfer (chain_id, to_addr, height DESC, tx_hash DESC, event_index DESC);

-- What each address holds: what came in minus what went out, over the stored transfers. A row exists only while
-- the balance is not zero, so a token's holders are its rows. Exact once coverage starts at genesis; while a refill
-- is still descending, a balance can be partial (even negative).
CREATE TABLE IF NOT EXISTS gno_grc20_balance (
  chain_id text          NOT NULL,
  token    text          NOT NULL,
  address  text          NOT NULL,
  balance  numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, token, address)
);
-- Holders ranked; an account's balances.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_grc20_balance_rank_idx
  ON gno_grc20_balance (chain_id, token, balance DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS gno_grc20_balance_address_idx
  ON gno_grc20_balance (chain_id, address);

-- Kept by the database, in the writer's transaction, so every writer is counted (the follower, a refill, a hand
-- repair). Statement-level triggers over the transition tables: an insert adds, an update moves the difference, a
-- delete takes it off; a rewrite of an unchanged event changes no row (the writer's upsert skips it), so it moves
-- nothing. Rows are written in key order so two writers cannot deadlock on them.
CREATE OR REPLACE FUNCTION gno_grc20_balance_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gno_grc20_balance AS b (chain_id, token, address, balance)
  SELECT chain_id, token, address, sum(d)
    FROM (SELECT chain_id, token, to_addr AS address, amount AS d FROM new_rows WHERE to_addr <> ''
          UNION ALL
          SELECT chain_id, token, from_addr, -amount FROM new_rows WHERE from_addr <> '') x
   GROUP BY 1, 2, 3 HAVING sum(d) <> 0 ORDER BY 1, 2, 3
  ON CONFLICT (chain_id, token, address) DO UPDATE SET balance = b.balance + EXCLUDED.balance;
  DELETE FROM gno_grc20_balance b
   USING (SELECT chain_id, token, to_addr AS address FROM new_rows WHERE to_addr <> ''
          UNION SELECT chain_id, token, from_addr FROM new_rows WHERE from_addr <> '') k
   WHERE b.chain_id = k.chain_id AND b.token = k.token AND b.address = k.address AND b.balance = 0;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION gno_grc20_balance_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gno_grc20_balance AS b (chain_id, token, address, balance)
  SELECT chain_id, token, address, sum(d)
    FROM (SELECT chain_id, token, to_addr AS address, amount AS d FROM new_rows WHERE to_addr <> ''
          UNION ALL
          SELECT chain_id, token, from_addr, -amount FROM new_rows WHERE from_addr <> ''
          UNION ALL
          SELECT chain_id, token, to_addr, -amount FROM old_rows WHERE to_addr <> ''
          UNION ALL
          SELECT chain_id, token, from_addr, amount FROM old_rows WHERE from_addr <> '') x
   GROUP BY 1, 2, 3 HAVING sum(d) <> 0 ORDER BY 1, 2, 3
  ON CONFLICT (chain_id, token, address) DO UPDATE SET balance = b.balance + EXCLUDED.balance;
  DELETE FROM gno_grc20_balance b
   USING (SELECT chain_id, token, to_addr AS address FROM new_rows UNION SELECT chain_id, token, from_addr FROM new_rows
          UNION SELECT chain_id, token, to_addr FROM old_rows UNION SELECT chain_id, token, from_addr FROM old_rows) k
   WHERE b.chain_id = k.chain_id AND b.token = k.token AND b.address = k.address AND b.balance = 0;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION gno_grc20_balance_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gno_grc20_balance AS b (chain_id, token, address, balance)
  SELECT chain_id, token, address, sum(d)
    FROM (SELECT chain_id, token, to_addr AS address, -amount AS d FROM old_rows WHERE to_addr <> ''
          UNION ALL
          SELECT chain_id, token, from_addr, amount FROM old_rows WHERE from_addr <> '') x
   GROUP BY 1, 2, 3 HAVING sum(d) <> 0 ORDER BY 1, 2, 3
  ON CONFLICT (chain_id, token, address) DO UPDATE SET balance = b.balance + EXCLUDED.balance;
  DELETE FROM gno_grc20_balance b
   USING (SELECT chain_id, token, to_addr AS address FROM old_rows WHERE to_addr <> ''
          UNION SELECT chain_id, token, from_addr FROM old_rows WHERE from_addr <> '') k
   WHERE b.chain_id = k.chain_id AND b.token = k.token AND b.address = k.address AND b.balance = 0;
  RETURN NULL;
END $$;

-- The triggers and a count from scratch, together and once (the transfer table is locked against writers for the
-- count, which is empty the first time). Later runs find the trigger and skip both.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'gno_grc20_transfer'::regclass AND tgname = 'gno_grc20_balance_ins') THEN
    LOCK TABLE gno_grc20_transfer IN SHARE ROW EXCLUSIVE MODE;
    CREATE TRIGGER gno_grc20_balance_ins AFTER INSERT ON gno_grc20_transfer
      REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION gno_grc20_balance_ins();
    CREATE TRIGGER gno_grc20_balance_upd AFTER UPDATE ON gno_grc20_transfer
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION gno_grc20_balance_upd();
    CREATE TRIGGER gno_grc20_balance_del AFTER DELETE ON gno_grc20_transfer
      REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION gno_grc20_balance_del();
    DELETE FROM gno_grc20_balance;
    INSERT INTO gno_grc20_balance (chain_id, token, address, balance)
    SELECT chain_id, token, address, sum(d)
      FROM (SELECT chain_id, token, to_addr AS address, amount AS d FROM gno_grc20_transfer WHERE to_addr <> ''
            UNION ALL
            SELECT chain_id, token, from_addr, -amount FROM gno_grc20_transfer WHERE from_addr <> '') x
     GROUP BY 1, 2, 3 HAVING sum(d) <> 0;
  END IF;
END $$;

-- ── capabilities ────────────────────────────────────────────────────────────
INSERT INTO extract_capability (name, min_version, description) VALUES
  ('gno_tx_msg', 5, 'gno_tx_msg: every gno message with kind, package, function, caller and args'),
  ('gno_grc20',  5, 'gno_grc20_token, gno_grc20_transfer and gno_grc20_balance, from the grc20 package''s events')
ON CONFLICT (name) DO UPDATE SET min_version = EXCLUDED.min_version, description = EXCLUDED.description;
-- Default privileges already give scan_ro, monitor and app_ro SELECT on new tables.
