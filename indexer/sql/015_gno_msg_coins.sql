-- Migration 015: the coins each gno message sends (Jove, 2026-11-15, for Gno Search: GNOT sent with calls and sends).
--
-- The tx-indexer has always served them (a send's amount; a call's, run's or deployment's send) and the follower
-- asked for most of them, but nothing kept them. Written at gno extract version 6; history by the gno refill.
-- Readers gate on indexer_coverage(chain, 'gno_msg_coins').
--
-- Re-runnable: IF NOT EXISTS everywhere. Adding nullable columns rewrites nothing.

-- coins: as the chain states them, "3540000ugnot", several joined by commas; NULL when the message sends none.
-- ugnot: the ugnot among them as a number, for sums; NULL when there is none.
ALTER TABLE gno_tx_msg ADD COLUMN IF NOT EXISTS coins text;
ALTER TABLE gno_tx_msg ADD COLUMN IF NOT EXISTS ugnot numeric;

INSERT INTO extract_capability (name, min_version, description) VALUES
  ('gno_msg_coins', 6, 'gno_tx_msg.coins and .ugnot: the coins each gno message sends')
ON CONFLICT (name) DO UPDATE SET min_version = EXCLUDED.min_version, description = EXCLUDED.description;
-- Readers keep their grants: a table-level SELECT covers new columns.
