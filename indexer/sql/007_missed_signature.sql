-- Phase 4: who failed to sign each block.
--
-- The one consensus-participation fact in this schema, and the only honest basis
-- for uptime over a window of our choosing. The chain keeps a single rolling
-- counter over signed_blocks_window (10,000 blocks on atomone-1) and nothing
-- behind it, so "was this validator up three months ago" has no on-chain answer.
-- Worse, min_signed_per_window is 5%, so a validator can miss 95% of that window
-- and never be jailed: the jail record is a very weak liveness signal.
--
-- ABSENCES ONLY, never presences. Every block carries one signature slot per
-- validator, so storing them all would be ~100 rows per height - a billion rows
-- for AtomOne alone, seventy times the rest of this database. Measured absence
-- runs at about 0.125%, so the same information costs ~1.3M rows. Presence is
-- the default, implied by the block existing with no row for that validator.
--
-- Uptime for a validator over a window is then:
--   1 - (its rows in the window) / (blocks in the window it was bonded for)
-- with membership taken from the days it proposed at all, which `block` answers.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS missed_signature (
  chain_id  text   NOT NULL,
  -- The height that was NOT signed. One BELOW the block the data arrived in:
  -- block N carries the commit for N-1.
  height    bigint NOT NULL,
  -- Consensus address, uppercase hex, exactly as the validator set reports it,
  -- so this joins block.proposer_cons with no translation.
  cons_addr text   NOT NULL,
  -- absent | nil.
  --   absent - the vote never arrived. This is downtime.
  --   nil    - the validator voted, but for nil. A live node disagreeing about
  --            the block, which is a different thing and must not be counted as
  --            downtime.
  flag      text   NOT NULL,
  PRIMARY KEY (chain_id, height, cons_addr)
);

-- "This validator's misses, newest first" - the uptime query.
CREATE INDEX IF NOT EXISTS missed_signature_validator_idx
  ON missed_signature (chain_id, cons_addr, height DESC);

-- "Who missed around here" - chain-wide, for a liveness overview.
CREATE INDEX IF NOT EXISTS missed_signature_height_idx
  ON missed_signature (chain_id, height DESC);

-- The stale-row index in 004 is partial on `extract_version < 2` and therefore
-- cannot serve the coverage query once EXTRACT_VERSION is 3. Replace it rather
-- than leave a seq scan behind; the old one has no other reader.
CREATE INDEX IF NOT EXISTS block_stale_extract_v3_idx
  ON block (chain_id, height) WHERE extract_version < 3;
DROP INDEX IF EXISTS block_stale_extract_idx;
