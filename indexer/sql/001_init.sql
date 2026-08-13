-- Indexer schema, phase 1: blocks, transactions, transfers, cursor.
--
-- See docs/INDEXER.md. The governing rule is "a projection, not a copy":
-- extracted facts only, never raw transaction bodies, so this stays in the
-- gigabytes rather than following the chain into terabytes.
--
-- Every table carries chain_id so one database serves every chain.
-- Amounts are numeric(78,0) — base denom, integer, wide enough for any Cosmos
-- supply. Heights are bigint. Times are timestamptz.

CREATE TABLE IF NOT EXISTS block (
  chain_id       text        NOT NULL,
  height         bigint      NOT NULL,
  time           timestamptz NOT NULL,
  -- Consensus address of the proposer, hex as the RPC reports it.
  proposer_cons  text,
  hash           text,
  tx_count       int         NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, height)
);

CREATE INDEX IF NOT EXISTS block_time_idx ON block (chain_id, time DESC);

CREATE TABLE IF NOT EXISTS tx (
  chain_id    text        NOT NULL,
  hash        text        NOT NULL,
  height      bigint      NOT NULL,
  tx_index    int         NOT NULL,
  time        timestamptz NOT NULL,
  -- ABCI result code; 0 is success.
  code        int         NOT NULL DEFAULT 0,
  fee_denom   text,
  fee_amount  numeric(78,0),
  gas_used    bigint,
  gas_wanted  bigint,
  -- Fee payer / first signer, from the tx event.
  signer      text,
  -- Message type URLs in order, for the type pills.
  msg_types   text[]      NOT NULL DEFAULT '{}',
  PRIMARY KEY (chain_id, hash)
);

CREATE INDEX IF NOT EXISTS tx_height_idx ON tx (chain_id, height DESC, tx_index);
CREATE INDEX IF NOT EXISTS tx_signer_idx ON tx (chain_id, signer) WHERE signer IS NOT NULL;

-- Value movements, taken from ABCI events rather than decoded messages.
--
-- Events are the better source: they carry reward amounts that the message
-- itself does not contain, and they capture transfers made through authz
-- without any unwrapping. One message can move several denominations, hence
-- coin_index in the key.
CREATE TABLE IF NOT EXISTS transfer (
  chain_id   text          NOT NULL,
  tx_hash    text          NOT NULL,
  -- -1 for a transfer emitted outside any message, e.g. the fee deduction.
  msg_index  int           NOT NULL,
  coin_index int           NOT NULL,
  height     bigint        NOT NULL,
  time       timestamptz   NOT NULL,
  -- transfer | reward | commission | fee
  kind       text          NOT NULL,
  from_addr  text,
  to_addr    text,
  denom      text          NOT NULL,
  amount     numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, msg_index, coin_index, kind)
);

CREATE INDEX IF NOT EXISTS transfer_from_idx ON transfer (chain_id, from_addr, height DESC)
  WHERE from_addr IS NOT NULL;
CREATE INDEX IF NOT EXISTS transfer_to_idx ON transfer (chain_id, to_addr, height DESC)
  WHERE to_addr IS NOT NULL;

-- Resume point, and the freshness signal Scan's read path gates on.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  chain_id     text        PRIMARY KEY,
  last_height  bigint      NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
