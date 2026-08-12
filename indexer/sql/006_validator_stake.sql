-- Periodic snapshots of each validator's bonded stake.
--
-- The only table here not derived from block contents. Bonded stake is module
-- state, not an event: a delegation emits a message, but the resulting total is
-- computed by the staking module and never appears in a block. Reconstructing
-- it from events would mean replaying every delegate, undelegate, redelegate,
-- slash and reward-restake since genesis and hoping the arithmetic matched.
-- Reading the total and writing it down is exact.
--
-- Why it exists: the 24-hour stake change was read from a node's historical
-- state via x-cosmos-block-height, which only archive nodes retain. On AtomOne
-- one public endpoint answers 500 and the other is a rotating proxy that is
-- archive on one request and pruned on the next, so the column appeared and
-- vanished between refreshes. Snapshots make the answer ours.
--
-- Deliberately small: ~100 validators per snapshot, hourly, is ~2,400 rows a
-- day per chain. Sub-hourly resolution buys nothing for a daily figure.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS validator_stake (
  chain_id  text          NOT NULL,
  height    bigint        NOT NULL,
  time      timestamptz   NOT NULL,
  operator  text          NOT NULL,
  -- Bonded tokens, base denom. numeric(78,0) like every other amount here.
  tokens    numeric(78,0) NOT NULL,
  -- Carried so a snapshot explains itself: a validator whose stake fell to zero
  -- because it was jailed is a different story from one that was unbonded from.
  jailed    boolean       NOT NULL DEFAULT false,
  PRIMARY KEY (chain_id, height, operator)
);

-- "This validator, around then" — the shape of a delta lookup.
CREATE INDEX IF NOT EXISTS validator_stake_operator_idx
  ON validator_stake (chain_id, operator, time DESC);

-- "The whole set, at the snapshot nearest a moment" — the shape of the table
-- view, which needs every validator at two points in time.
CREATE INDEX IF NOT EXISTS validator_stake_time_idx
  ON validator_stake (chain_id, time DESC);
