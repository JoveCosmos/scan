-- Extract version 4: every movement, party and message, and coverage per capability.
--
-- What 2026-09-25's audit found, measured on a copy of the production database:
--
--   * Before AtomOne's SDK upgrade (~9,550,000) no event carried msg_index, and
--     "no index" was read as "outside any message": all 2,137,161 transfer rows
--     below it are kind 'fee', and not one is 'transfer'. Under the old key
--     (tx, msg_index, coin_index, kind) they overwrote each other, so each
--     transaction kept one row per coin: MultiSend lost 100% of its outputs in
--     sampling (28,012 movements stored as 12 rows), MsgExec 97%, MsgSend 48%.
--   * After it, same-kind events inside one message still collide: authz MsgExec
--     batches lost 86% of their movements (inner messages share the outer
--     msg_index), MultiSend 44%.
--   * A double sign's jailing arrives in a second `slash` event without an
--     address and was skipped: height 1,663,342 has a slash and no tombstone.
--   * Unjails were never recorded.
--
-- Version 4 keys every event-derived row on the event's ordinal in its
-- transaction (event_seq), recovers pre-upgrade grouping from the result log,
-- and adds the tables below. Written by the indexer at extract_version 4; what
-- each reader may rely on is declared per capability in extract_capability, so
-- raising the version never darkens a feature that an older version already
-- served (a refill runs for days).
--
-- Re-runnable. Index builds over the large tables are in 009 (CONCURRENTLY).
-- The follower must be stopped while 009 swaps transfer's key and restarted on
-- a version-4 build: a version-3 writer's ON CONFLICT names the old key.

-- ── what each reader may rely on ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS extract_capability (
  name        text     PRIMARY KEY,
  -- The lowest block.extract_version that carries this capability.
  min_version smallint NOT NULL,
  description text     NOT NULL
);

INSERT INTO extract_capability (name, min_version, description) VALUES
  ('blocks',             0, 'block rows: height, time, proposer, hash, tx_count'),
  ('fees',               1, 'tx rows with fee, gas, signer, msg_types'),
  ('votes',              2, 'vote: the final vote per voter per proposal'),
  ('slashing',           2, 'slash_event: slashed and jailed from block events'),
  ('missed_signatures',  3, 'missed_signature: absent/nil commit slots'),
  ('transfers',          4, 'transfer keyed by (tx_hash, event_seq, coin_index), kinds correct in both eras'),
  ('tx_meta',            4, 'tx.memo, signers, fee_granter, codespace, fee_coins'),
  ('tx_party',           4, 'tx_party: every account/operator party to a tx, with roles'),
  ('tx_msg',             4, 'tx_msg: messages from the tx bytes, authz inner messages and failed txs included'),
  ('ibc_packet',         4, 'ibc_packet: send/recv/ack/timeout per packet'),
  ('staking_event',      4, 'staking_event: delegate, undelegate, redelegate, cancel, create, edit, completions'),
  ('validator_power',    4, 'validator_power: every validator_update'),
  ('gov_deposit',        4, 'gov_deposit: every deposit'),
  ('gov_proposal',       4, 'gov_proposal: proposer, submit tx, outcome'),
  ('vote_event',         4, 'vote_event: every vote as cast, re-votes included'),
  ('tombstones_unjails', 4, 'slash_event also carries double-sign tombstones and unjails')
ON CONFLICT (name) DO UPDATE SET min_version = EXCLUDED.min_version,
                                 description = EXCLUDED.description;

-- Heights an archive could not serve, recorded rather than skipped, plus every
-- hole found by a scan of `block`. Coverage stops at the nearest one.
CREATE TABLE IF NOT EXISTS block_gap (
  chain_id  text        NOT NULL,
  lo        bigint      NOT NULL,
  hi        bigint      NOT NULL,
  reason    text        NOT NULL,
  found_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, lo)
);

-- The node's head as the follower last saw it, so lag (head - last_height) and
-- staleness (now - updated_at) are separate readings.
ALTER TABLE indexer_cursor ADD COLUMN IF NOT EXISTS head_height bigint;

-- ── transfer: keyed by the event ──────────────────────────────────────────────
-- event_seq is the event's ordinal in the transaction; msg_index stays (-1 for
-- the fee) and authz_msg_index is new. Rows written before version 4 have no
-- event_seq and are replaced per transaction as the refill reaches them.
ALTER TABLE transfer ADD COLUMN IF NOT EXISTS event_seq int;
ALTER TABLE transfer ADD COLUMN IF NOT EXISTS authz_msg_index int;

-- ── tx: what the events never said ───────────────────────────────────────────
ALTER TABLE tx ADD COLUMN IF NOT EXISTS memo        text;
ALTER TABLE tx ADD COLUMN IF NOT EXISTS signers     text[];
ALTER TABLE tx ADD COLUMN IF NOT EXISTS fee_granter text;
ALTER TABLE tx ADD COLUMN IF NOT EXISTS codespace   text;
-- Every fee coin as [{"denom":…,"amount":…}]; fee_denom/fee_amount keep the first.
ALTER TABLE tx ADD COLUMN IF NOT EXISTS fee_coins   jsonb;

-- ── tx_party: who a transaction touched ──────────────────────────────────────
-- Every bech32 account or operator address in the transaction's events, its
-- signers (acc_seq), fee payer and granter, authz granters and grantee, and
-- IBC relayers. Module accounts (fee collector, distribution, bonded pools, gov,
-- mint, IBC escrows...) are left out: they are party to nearly everything.
--
-- roles is a bitmask: 1 signer, 2 fee_payer, 4 fee_granter, 8 sender,
-- 16 recipient, 32 delegator, 64 validator, 128 voter, 256 depositor,
-- 512 proposer, 1024 granter, 2048 grantee, 4096 relayer, 8192 other.
--
-- The primary key is the account-history index: one account, newest first,
-- keyset-paged on (height, tx_hash) descending.
CREATE TABLE IF NOT EXISTS tx_party (
  chain_id text   NOT NULL,
  address  text   NOT NULL,
  height   bigint NOT NULL,
  tx_hash  text   NOT NULL,
  roles    int    NOT NULL,
  PRIMARY KEY (chain_id, address, height, tx_hash)
);

-- ── tx_msg: messages, from the transaction's bytes ───────────────────────────
-- inner_index is -1 for a top-level message and the position inside an authz
-- MsgExec otherwise. Failed transactions included (their events say nothing).
-- sender is the first address-shaped top-level string of the message (its
-- signer field for every Cosmos SDK message; a MultiSend's first input).
CREATE TABLE IF NOT EXISTS tx_msg (
  chain_id    text   NOT NULL,
  tx_hash     text   NOT NULL,
  msg_index   int    NOT NULL,
  inner_index int    NOT NULL,
  type_url    text   NOT NULL,
  sender      text,
  height      bigint NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, msg_index, inner_index)
);

-- ── ibc_packet: one row per packet, per direction ────────────────────────────
-- direction 'out': this chain sent it (send, then ack or timeout here).
-- direction 'in':  this chain received it (recv, and the ack it wrote).
-- (src_port, src_channel, sequence) identifies a packet on its source chain; the
-- direction is in the key because a received packet's source channel is the
-- counterparty's, and channel-0 on both ends of a young channel is common.
-- Written column by column: each event fills only its own columns.
CREATE TABLE IF NOT EXISTS ibc_packet (
  chain_id          text          NOT NULL,
  direction         text          NOT NULL,
  src_port          text          NOT NULL,
  src_channel       text          NOT NULL,
  sequence          bigint        NOT NULL,
  dst_port          text,
  dst_channel       text,
  connection_id     text,
  sender            text,
  receiver          text,
  denom             text,
  amount            numeric(78,0),
  memo              text,
  timeout_height    text,
  timeout_timestamp numeric(30,0),
  send_height       bigint,
  send_tx           text,
  send_time         timestamptz,
  recv_height       bigint,
  recv_tx           text,
  recv_time         timestamptz,
  recv_relayer      text,
  ack_height        bigint,
  ack_tx            text,
  ack_time          timestamptz,
  ack_relayer       text,
  -- 'out': whether the counterparty accepted it; 'in': the ack this chain wrote.
  ack_ok            boolean,
  ack_error         text,
  timeout_at_height bigint,
  timeout_tx        text,
  PRIMARY KEY (chain_id, direction, src_port, src_channel, sequence)
);

-- ── staking_event ────────────────────────────────────────────────────────────
-- kind: delegate | undelegate | redelegate | cancel_unbonding | create_validator
--       | edit_validator | complete_unbonding | complete_redelegation
-- tx_hash is '' for the end-block completions, keyed then by the event's ordinal
-- in the block's events.
CREATE TABLE IF NOT EXISTS staking_event (
  chain_id        text          NOT NULL,
  height          bigint        NOT NULL,
  tx_hash         text          NOT NULL,
  event_seq       int           NOT NULL,
  time            timestamptz   NOT NULL,
  kind            text          NOT NULL,
  validator       text,
  validator_dst   text,
  delegator       text,
  amount          numeric(78,0),
  denom           text,
  completion_time timestamptz,
  creation_height bigint,
  msg_index       int,
  authz_msg_index int,
  PRIMARY KEY (chain_id, height, tx_hash, event_seq)
);

-- ── validator_power: every validator_update ──────────────────────────────────
-- cons_addr is uppercase hex, joinable with block.proposer_cons and
-- missed_signature. Power 0 means the validator left the active set.
CREATE TABLE IF NOT EXISTS validator_power (
  chain_id  text          NOT NULL,
  height    bigint        NOT NULL,
  cons_addr text          NOT NULL,
  power     numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, height, cons_addr)
);

-- ── governance history ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gov_deposit (
  chain_id    text        NOT NULL,
  tx_hash     text        NOT NULL,
  event_seq   int         NOT NULL,
  proposal_id bigint      NOT NULL,
  depositor   text,
  -- [{"denom":…,"amount":…}]
  coins       jsonb       NOT NULL,
  height      bigint      NOT NULL,
  time        timestamptz NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, event_seq)
);

-- Column-scoped like ibc_packet: the submit fills its columns, the end-block
-- outcome fills its own. outcome: passed | rejected | failed | dropped.
CREATE TABLE IF NOT EXISTS gov_proposal (
  chain_id       text        NOT NULL,
  proposal_id    bigint      NOT NULL,
  submit_height  bigint,
  submit_tx      text,
  submit_time    timestamptz,
  proposer       text,
  messages       text[],
  outcome        text,
  outcome_height bigint,
  outcome_time   timestamptz,
  PRIMARY KEY (chain_id, proposal_id)
);

-- Every vote as cast, re-votes included; `vote` keeps holding the final one.
CREATE TABLE IF NOT EXISTS vote_event (
  chain_id    text        NOT NULL,
  tx_hash     text        NOT NULL,
  event_seq   int         NOT NULL,
  proposal_id bigint      NOT NULL,
  voter       text        NOT NULL,
  option      text        NOT NULL,
  weighted    boolean     NOT NULL DEFAULT false,
  options     jsonb,
  height      bigint      NOT NULL,
  time        timestamptz NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, event_seq)
);

-- ── validator identities ─────────────────────────────────────────────────────
-- Operator <-> consensus address, from MsgCreateValidator's key and, for
-- validators created at genesis, from the staking API (backfill-cli
-- BACKFILL_LCD). An unjail names only the operator; this is how it is tied to
-- the same validator's jail rows, which carry only the consensus address.
CREATE TABLE IF NOT EXISTS validator_key (
  chain_id     text   NOT NULL,
  operator     text   NOT NULL,
  -- Uppercase hex, as block.proposer_cons and missed_signature write it.
  cons_hex     text   NOT NULL,
  -- bech32 valcons, as slash_event writes it.
  cons_valcons text   NOT NULL,
  first_height bigint,
  PRIMARY KEY (chain_id, operator)
);

CREATE INDEX IF NOT EXISTS validator_key_valcons_idx ON validator_key (chain_id, cons_valcons);
CREATE INDEX IF NOT EXISTS validator_key_hex_idx ON validator_key (chain_id, cons_hex);

-- Small tables: plain index builds.
CREATE INDEX IF NOT EXISTS tx_msg_type_idx      ON tx_msg (chain_id, type_url, height DESC);
CREATE INDEX IF NOT EXISTS ibc_packet_sender_idx   ON ibc_packet (chain_id, sender) WHERE sender IS NOT NULL;
CREATE INDEX IF NOT EXISTS ibc_packet_receiver_idx ON ibc_packet (chain_id, receiver) WHERE receiver IS NOT NULL;
CREATE INDEX IF NOT EXISTS ibc_packet_send_tx_idx  ON ibc_packet (chain_id, send_tx) WHERE send_tx IS NOT NULL;
CREATE INDEX IF NOT EXISTS ibc_packet_recv_tx_idx  ON ibc_packet (chain_id, recv_tx) WHERE recv_tx IS NOT NULL;
CREATE INDEX IF NOT EXISTS ibc_packet_ack_tx_idx   ON ibc_packet (chain_id, ack_tx) WHERE ack_tx IS NOT NULL;
CREATE INDEX IF NOT EXISTS staking_event_validator_idx     ON staking_event (chain_id, validator, height DESC) WHERE validator IS NOT NULL;
CREATE INDEX IF NOT EXISTS staking_event_validator_dst_idx ON staking_event (chain_id, validator_dst, height DESC) WHERE validator_dst IS NOT NULL;
CREATE INDEX IF NOT EXISTS staking_event_delegator_idx     ON staking_event (chain_id, delegator, height DESC) WHERE delegator IS NOT NULL;
CREATE INDEX IF NOT EXISTS validator_power_cons_idx ON validator_power (chain_id, cons_addr, height DESC);
CREATE INDEX IF NOT EXISTS gov_deposit_proposal_idx  ON gov_deposit (chain_id, proposal_id);
CREATE INDEX IF NOT EXISTS gov_deposit_depositor_idx ON gov_deposit (chain_id, depositor) WHERE depositor IS NOT NULL;
CREATE INDEX IF NOT EXISTS vote_event_proposal_idx ON vote_event (chain_id, proposal_id, height DESC);
CREATE INDEX IF NOT EXISTS vote_event_voter_idx    ON vote_event (chain_id, voter, height DESC);
CREATE INDEX IF NOT EXISTS slash_event_operator_idx ON slash_event (chain_id, operator, height DESC) WHERE operator IS NOT NULL;

-- ── coverage per capability ──────────────────────────────────────────────────
-- The contiguous run of blocks ending at the newest one in which every block
-- carries the capability: no recorded gap (block_gap) and no block written by an
-- extractor older than the capability. `lo`/`hi` are heights, with their times.
-- A refill that descends from the head grows this run downward as it goes.
--
-- One index probe per older version (block_version_idx, 009) and one per gap,
-- so it is cheap enough to call per request (Scan caches it anyway).
CREATE OR REPLACE FUNCTION indexer_coverage(p_chain text, p_capability text)
RETURNS TABLE (lo bigint, hi bigint, lo_time timestamptz, hi_time timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_min   smallint;
  v_hi    bigint;
  v_low   bigint;
  v_floor bigint;
  v_x     bigint;
  v       int;
BEGIN
  SELECT c.min_version INTO v_min FROM extract_capability c WHERE c.name = p_capability;
  IF v_min IS NULL THEN RETURN; END IF;

  SELECT max(b.height) INTO v_hi FROM block b WHERE b.chain_id = p_chain;
  IF v_hi IS NULL THEN RETURN; END IF;
  SELECT min(b.height) INTO v_low FROM block b WHERE b.chain_id = p_chain;

  -- The newest block written below the capability's version.
  FOR v IN 0 .. v_min - 1 LOOP
    SELECT max(b.height) INTO v_x FROM block b
     WHERE b.chain_id = p_chain AND b.extract_version = v;
    v_floor := GREATEST(v_floor, v_x);
  END LOOP;

  -- The newest hole.
  SELECT max(g.hi) INTO v_x FROM block_gap g WHERE g.chain_id = p_chain AND g.lo <= v_hi;
  v_floor := GREATEST(v_floor, v_x);

  lo := GREATEST(COALESCE(v_floor + 1, v_low), v_low);
  hi := v_hi;
  IF lo > hi THEN RETURN; END IF;
  SELECT b.time INTO lo_time FROM block b WHERE b.chain_id = p_chain AND b.height = lo;
  SELECT b.time INTO hi_time FROM block b WHERE b.chain_id = p_chain AND b.height = hi;
  RETURN NEXT;
END
$$;

GRANT EXECUTE ON FUNCTION indexer_coverage(text, text) TO scan_ro;
