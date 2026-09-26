-- Record every hole already inside each chain's stored range.
--
-- Coverage used to read min and max, so a height the backfill skipped looked
-- covered. From version 4 the backfill records what it could not fetch
-- (block_gap); this finds what earlier runs left behind. osmosis-1 holds
-- deliberate islands far below its contiguous range (targeted backfills for the
-- GATA reconcile, 2026-09-09 — never delete them); they become recorded gaps,
-- which is exactly what they are, and coverage stops above them.
--
-- One ordered pass over block's primary key. Re-runnable: a gap already
-- recorded is kept, a gap since filled is removed.

INSERT INTO block_gap (chain_id, lo, hi, reason)
SELECT chain_id, height + 1, next - 1, 'scan'
  FROM (SELECT chain_id, height,
               lead(height) OVER (PARTITION BY chain_id ORDER BY height) AS next
          FROM block) t
 WHERE next > height + 1
ON CONFLICT (chain_id, lo) DO NOTHING;

DELETE FROM block_gap g
 WHERE g.reason = 'scan'
   AND EXISTS (SELECT 1 FROM block b WHERE b.chain_id = g.chain_id AND b.height = g.lo);
