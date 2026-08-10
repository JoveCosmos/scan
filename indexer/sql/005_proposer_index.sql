-- Index blocks by who proposed them.
--
-- Counting a validator's proposed blocks is otherwise a full scan of every
-- block on the chain, once per validator page view. With this it is an index
-- range scan over that validator's own rows.
--
-- CONCURRENTLY because the backfill and follower are writing to this table
-- continuously, and a plain CREATE INDEX takes a lock that would stall both for
-- as long as the build takes. The cost is that it cannot run inside a
-- transaction — fine here, since migrate.sh pipes statements in autocommit.
--
-- If a concurrent build is interrupted it leaves an invalid index behind, which
-- is not used for queries and is not an error; drop it and re-run.
--
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--
-- Re-runnable.

CREATE INDEX CONCURRENTLY IF NOT EXISTS block_proposer_idx
  ON block (chain_id, proposer_cons, height DESC)
  WHERE proposer_cons IS NOT NULL;
