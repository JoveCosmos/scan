-- Indexer schema, phases 2 and 3: governance votes and slashing history.
--
-- Both are extracted from the same /block_results responses phase 1 already
-- reads, which is why they are added before the long backfill rather than
-- after: fetching those blocks a second and third time would cost days for
-- data we had in hand the first time.
--
-- Same rules as 001 — chain_id everywhere, numeric(78,0) amounts, bigint
-- heights, timestamptz times. Re-runnable: every statement is IF NOT EXISTS.

-- One row per voter per proposal, holding their *final* vote.
--
-- Voters may recast while voting is open, and the gov module deletes votes from
-- state once it tallies, so this table is the only lasting record for a
-- finished proposal. Today Scan reconstructs it from tens of paged
-- tx-search requests — about 30 seconds for a large AtomOne proposal — which
-- this replaces with one indexed query.
CREATE TABLE IF NOT EXISTS vote (
  chain_id    text        NOT NULL,
  proposal_id bigint      NOT NULL,
  -- The granter when cast through authz, never the grantee: the account whose
  -- stake the vote actually carries.
  voter       text        NOT NULL,
  -- Heaviest option, which is the whole vote for everyone but split voters.
  option      text        NOT NULL,
  weighted    boolean     NOT NULL DEFAULT false,
  -- Full split for weighted votes; null for the ordinary single-option case.
  options     jsonb,
  height      bigint      NOT NULL,
  time        timestamptz NOT NULL,
  tx_hash     text        NOT NULL,
  PRIMARY KEY (chain_id, proposal_id, voter)
);

-- The vote list for one proposal, newest first.
CREATE INDEX IF NOT EXISTS vote_proposal_idx
  ON vote (chain_id, proposal_id, height DESC);

-- Everything one account has voted on, for a governance-participation view.
CREATE INDEX IF NOT EXISTS vote_voter_idx ON vote (chain_id, voter);

-- Jailing, unjailing, tombstoning and slashing.
--
-- The feature no node can serve: jailing happens in BeginBlock rather than in a
-- transaction, so it is absent from tx search, and the slashing module keeps
-- only a current-state timestamp with no history or count. These rows are the
-- only way to answer "how many times has this validator been jailed".
--
-- Keyed naturally rather than by a serial id, so replaying a height is
-- idempotent — the property the whole crash-recovery story rests on.
CREATE TABLE IF NOT EXISTS slash_event (
  chain_id   text          NOT NULL,
  height     bigint        NOT NULL,
  time       timestamptz   NOT NULL,
  -- Consensus address, which is what the events carry. The operator address is
  -- resolved separately, since events never mention it.
  cons_addr  text          NOT NULL,
  operator   text,
  -- jailed | unjailed | tombstoned | slashed
  kind       text          NOT NULL,
  -- downtime | double_sign, when the event says.
  reason     text,
  -- Tokens burned, present on slash events only.
  burned     numeric(78,0),
  PRIMARY KEY (chain_id, height, cons_addr, kind)
);

-- A validator's own slash history, newest first.
CREATE INDEX IF NOT EXISTS slash_validator_idx
  ON slash_event (chain_id, cons_addr, height DESC);

-- Chain-wide recent slashing, for an overview panel.
CREATE INDEX IF NOT EXISTS slash_height_idx ON slash_event (chain_id, height DESC);
