-- Extract version 4, part two: index builds over the large tables, and
-- transfer's new key. CONCURRENTLY so the follower and readers are never
-- blocked for the build; migrate.sh pipes statements in autocommit, which
-- CONCURRENTLY requires.
--
-- ORDER MATTERS for transfer: the event key is built first, then the old key is
-- dropped. A version-3 writer's ON CONFLICT names the old key, so the follower
-- must be stopped before this runs and restarted on a version-4 build after.
--
-- An interrupted concurrent build leaves an INVALID index behind; it is unused
-- and harmless. Drop it and re-run:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--
-- Re-runnable.

-- transfer: (tx_hash, event_seq, coin_index) is the key from version 4 on.
-- Rows older than version 4 carry no event_seq; NULLs are distinct, so they
-- stay until the refill replaces them per transaction. The index's
-- (chain_id, tx_hash) prefix also serves that per-transaction replace.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS transfer_event_key
  ON transfer (chain_id, tx_hash, event_seq, coin_index);
ALTER TABLE transfer DROP CONSTRAINT IF EXISTS transfer_pkey;

-- Filter transactions by message type without a scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_msg_types_gin
  ON tx USING gin (msg_types);

-- Fee grants: who paid for whom.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_fee_granter_idx
  ON tx (chain_id, fee_granter) WHERE fee_granter IS NOT NULL;

-- indexer_coverage(): "the newest block below version v" is one probe per v.
CREATE INDEX CONCURRENTLY IF NOT EXISTS block_version_idx
  ON block (chain_id, extract_version, height);
