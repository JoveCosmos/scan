-- Record which extractor wrote each block.
--
-- "We have this block" and "we have everything in this block" are not the same
-- claim, and treating them as one produced a real error: AtomOne blocks written
-- before vote extraction existed looked complete, so proposal 21 — whose voting
-- period straddles the boundary — held 391 of its roughly 5,400 votes while the
-- coverage check reported the period as fully covered. A partial answer
-- rendered as fact is worse than no answer at all.
--
-- Default 0 means "written by an extractor that did not record this", which is
-- the safe reading for every row already in the table. The known-good range is
-- then raised explicitly below.
--
-- Re-runnable.

ALTER TABLE block
  ADD COLUMN IF NOT EXISTS extract_version smallint NOT NULL DEFAULT 0;

-- Finding the stale ceiling is a min() over a filtered scan on every coverage
-- check; a partial index keeps it to the rows that can actually be stale.
CREATE INDEX IF NOT EXISTS block_stale_extract_idx
  ON block (chain_id, height)
  WHERE extract_version < 2;

-- AtomOne: everything below 9,204,236 was written by the backfill, which has
-- extracted votes and slashing events since its first run. At and above that
-- height the follower wrote blocks with an older build, and those carry no vote
-- rows at all — confirmed against the data: all 3,826 vote rows sit below the
-- line and none above it.
--
-- This is a fact about this deployment rather than a general rule, which is why
-- it is written down here instead of inferred. On a fresh database it matches
-- nothing and costs nothing.
UPDATE block
   SET extract_version = 2
 WHERE chain_id = 'atomone-1'
   AND height < 9204236
   AND extract_version < 2;
