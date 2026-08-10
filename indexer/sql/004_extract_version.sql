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

-- AtomOne holds one stale band, closed at both ends: heights 9,204,236 through
-- 9,832,411, written by a follower running a build with no vote extraction. The
-- two ranges around it are sound and are raised here.
--
-- Below 9,204,236 is the backfill's work, which has extracted votes and
-- slashing events since its first run. Above 9,832,411 is the same follower
-- after it was restarted on 2026-08-10 at 12:54:44 UTC onto a build that does.
--
-- The data agrees: all 3,826 vote rows sit below the lower bound and none
-- within the band.
--
-- These are facts about this deployment rather than general rules, which is why
-- they are written down instead of inferred. On a fresh database they match
-- nothing and cost nothing.
UPDATE block
   SET extract_version = 2
 WHERE chain_id = 'atomone-1'
   AND (height < 9204236 OR height > 9832411)
   AND extract_version < 2;
