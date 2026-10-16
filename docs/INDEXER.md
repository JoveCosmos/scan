# Indexer

A companion service that turns the chains' live feed into a small, queryable
history in Postgres, so Scan can answer questions no node can: jail and
slash history, uptime beyond the signing window, fast vote and delegator
queries, and trends over time.

Status: **extract version 4** (`indexer/`, 2026-09-26). The current contract
with Scan — every table, its key, which version carries it and how to read it —
is [Contract with Scan](#contract-with-scan-extract-version-4) below; the
original design sections after it are kept as history and are superseded
wherever the two differ.

Things phase 1 settled that the plan had left open:

- **No transaction index needed.** A tx hash is `sha256(raw bytes)`, derived
  locally from the block and verified against the chain, so `tx_index: off` is
  fine.
- **Events first, bytes where events are silent.** The ABCI events carry *more*
  than the messages: a reward withdrawal's amount exists only in the event. But
  a failed transaction emits no message events, the memo and fee granter are
  never in an event, and an authz batch names its inner messages only through
  their side effects — so version 4 also reads the transaction's own bytes
  (`indexer/src/proto.ts`, four wire types, no dependency).

## Decisions (settled)

- **Chains in scope:** `cosmoshub-4`, `atomone-1`, `akashnet-2` (mainnet) plus
  `atomone-testnet-1` and `sapphire-1` (gno.land testnet). Keep the design flexible
  for a **gno.land mainnet** later.
- **gno.land is a different chain kind** — Tendermint2, no `/cosmos/*` modules,
  no staking/gov/slashing. It gets blocks and txs only, from its own RPC +
  indexing API, mirroring Scan's existing cosmos/gno adapter split. The
  event tables below (`vote`, `slash_event`, `validator_snapshot`) are
  Cosmos-only and simply do not populate for gno.
- **Read source:** **backfill from public full/archive nodes on the internet**
  (heavy, off our box), then **follow the head from our own local validator
  node** for ongoing writes. This split is deliberate — backfill is thousands of
  rapid requests (kept off the validator), while ongoing head-follow is ~one
  `/block` + `/block_results` every block time, light enough not to disturb
  consensus.
- **Backfill depth:** genesis for AtomOne (mainnet + testnet, cheap, verified
  archive); **~1 year** for Cosmos Hub and Akash — recent proposals, jail
  history and charts without the slow full-archive replay.
- **Postgres:** a **pinned-version Docker container**, localhost-bound.
- **`transfer` retention:** **full, indefinitely** to start; add thinning only
  if it actually grows large.

## Why

Some facts a Scan wants are simply not answerable from a node:

- **Jail / slash history** — jailing happens in `BeginBlock`, not a transaction,
  so it is not in tx search; the slashing module keeps no counter.
- **Uptime beyond the slashing window** — the node exposes only the current
  window's missed-block counter.
- **Fast vote and delegator reads** — reconstructing a finished proposal today
  costs tens of sequential tx-search pages (~30s for AtomOne prop 21); a
  delegator ranking rescans thousands of rows.
- **Trends** — stake, commission, bonded ratio, community pool over time.
- **The 24h stake delta** currently uses `x-cosmos-block-height` to read
  yesterday's state. **A pruned node cannot answer that** — so once we prune,
  this feature depends on the indexer.

## Principles

1. **A projection, not a copy.** Store the extracted *facts* we query — events,
   snapshots, transfer parties — never raw transaction bodies for all history.
   This is the difference between low-double-digit GB and hundreds of GB. It is
   the single most important rule.
2. **Postgres is the memory; the node is the feed.** The node stays pruned and
   small. Postgres is the permanent record of what we index.
3. **Never worse than today.** Scan reads Postgres first and falls back
   to the existing live-node path when the indexer lags or a table is empty.
   Shipping the indexer must not be able to break a working page.
4. **Isolated, like Scan.** Own system user, own database, own systemd
   unit, localhost only. Same posture as `deploy/` — see
   [ARCHITECTURE.md](ARCHITECTURE.md) and the isolation rule Scan
   already follows.

## Architecture

```
 backfill (once):  public archive / full nodes on the internet
                          │  historical /block_results, throttled
                          ▼
 ongoing:  local validator node (pruned, few-days buffer)
        │  RPC on localhost: /block, /block_results, ~1 req per block
        ▼
 indexer worker  ── follows head, extracts events + periodic snapshots
        │  writes
        ▼
 Postgres (localhost, Docker)  ── the projection
        │  reads (localhost, sub-ms)
        ▼
 scan  ── Postgres first, live-node fallback when the cursor lags
```

**Ongoing reads come from our own validator node; backfill does not.** The
head-follow is light — one `/block` + `/block_results` per block time — so it
does not disturb consensus, and the validator's own uptime incentive makes it a
reliable local source. The **heavy** part, backfilling months or years of
history in thousands of rapid requests, is deliberately kept **off** the
validator and pointed at public archive/full nodes instead (see Backfill).

**The key endpoint is `/block_results`.** It carries the ABCI events —
`begin_block_events`, `end_block_events`, and per-tx events — which is where
slash, jail, vote, and reward data live. It works **even with `tx_index: off`**,
because we read results by height, not by searching an index.

## What the node must retain

The indexer captures each block *when it is fresh*, so the node only needs a
buffer, not history:

- **`min-retain-blocks`** set to a few days' worth, so a worker that falls
  behind (a crash, a redeploy) can always catch up before the data is pruned.
- **`discard_abci_responses = false`** (CometBFT `[storage]`). If ABCI responses
  are discarded, `/block_results` returns nothing for past heights and the
  buffer is useless. This must be verified per node.
- State pruning can be as aggressive as we like — the indexer never reads
  historical *state* by height once snapshots are in Postgres.

## Contract with Scan (extract version 4)

Written 2026-09-26 by the indexer session. This is what the indexer promises;
Scan reads nothing that is not listed here. Changes to this section are
announced to the Scan session before they ship.

### Why version 4

Measured on a copy of production (snapshot 2026-09-26 00:41 UTC) and against
the chain:

1. **Pre-upgrade transfers were stored as fees and overwrote each other.**
   Before AtomOne's SDK upgrade at ~9,550,000 no event carries `msg_index`; the
   extractor read "no index" as "the fee". Below that height 2,137,161 rows were
   kind `fee` and not one was `transfer`, and under the old key
   `(tx_hash, msg_index, coin_index, kind)` they collapsed to one row per coin:
   in sampling, MultiSend lost 100% of its movements (28,012 events → 12 rows),
   MsgExec 97%, RecvPacket 50%, MsgSend 48%, reward withdrawals 41%. Scan's
   account history (which excludes fees) therefore showed **no incoming
   transfers at all** before 9,550,000.
2. **Post-upgrade, same-kind events inside one message still collided:** an
   authz MsgExec's inner messages share the outer `msg_index`, so batches lost
   86% of their movements, MultiSend 44%.
3. Missed blocks — already fixed in production by `missed_signature`
   (version 3).
4. `updated_at` froze whenever a chain paused, so a reader could not tell
   "caught up" from "stuck".
5. A node that dropped its ABCI responses produced hollow rows that looked
   complete (latent — none found in production).
6. A backfill batch that failed outright ended the run as "complete", and a
   single unfetchable height became an invisible hole.
7. A double sign's jailing arrives in a second `slash` event with no address and
   was dropped (height 1,663,342: slashed, never tombstoned); the 76 unjails on
   AtomOne were never recorded.
8. Only the first fee coin was kept; signers, fee granter and memo not at all.
9. The stale band (`extract_version < 2`) is gone: 0 rows.

### Keys and versions

`block.extract_version` is the extractor that last wrote the block's rows. A
reader does not compare versions itself — it asks for a **capability**:

```sql
SELECT lo, hi, lo_time, hi_time FROM indexer_coverage($chain, $capability);
```

returns the contiguous run of blocks, ending at the newest block that carries
the capability, in which every block carries it: no recorded gap (`block_gap`)
and no block written by an older extractor. No row means "not covered — use the
live path". 5–17 ms on the production-size copy; Scan's 30 s cache is plenty.

(Since migration 011 the run ends at the newest block that *carries* the
capability, not the newest block of any version: `gno-signatures` writes
gnoland-1 blocks at version 3 as they are produced, usually ahead of the gno
follower, and one such block at the top used to empty every gnoland-1
capability. A block above `hi` is simply not processed yet; freshness says how
far behind that is.) A refill descends from
the head, so a version-4 capability's `lo` moves down as it runs; a capability
an older version already served (`votes`, `fees`, `slashing`) stays fully
covered throughout.

| capability | min version | rows |
|---|---|---|
| blocks | 0 | `block` |
| fees | 1 | `tx` fee, gas, signer, msg_types |
| votes | 2 | `vote` (final vote per voter) |
| slashing | 2 | `slash_event` slashed / jailed |
| missed_signatures | 3 | `missed_signature` |
| transfers | 4 | `transfer` with correct kinds in both eras |
| tx_meta | 4 | `tx.memo`, `signers`, `fee_granter`, `codespace`, `fee_coins` |
| tx_party | 4 | `tx_party` |
| tx_msg | 4 | `tx_msg` |
| ibc_packet | 4 | `ibc_packet` |
| staking_event | 4 | `staking_event` |
| validator_power | 4 | `validator_power` |
| gov_deposit | 4 | `gov_deposit` |
| gov_proposal | 4 | `gov_proposal` |
| vote_event | 4 | `vote_event` |
| tombstones_unjails | 4 | `slash_event` kinds `tombstoned`, `unjailed` |
| gno_tx | 4 | `gno_tx` (gno chains) |
| gno_tx_party | 4 | `gno_tx_party` (gno chains) |
| address_tx_count | 4 | `address_tx_count` — see its section for what "covered" means |
| proposer_count | 0 | `proposer_blocks()` over `block_proposer_count` (migration 013) |
| commission_signer | 4 | `transfer.signer` on commission rows (migration 013) |
| validator_power_time | 4 | `validator_power.time` (migration 013) |
| gno_tx_msg | 5 (gno) | `gno_tx_msg` (migration 014) |
| gno_grc20 | 5 (gno) | `gno_grc20_token`, `gno_grc20_transfer`, `gno_grc20_balance` (migration 014) |

The list lives in `extract_capability` (migration 008) and in `CAPABILITIES` in
`indexer/src/extract.ts`; they must agree.

Version 0 marks a **hollow** block: the node returned no ABCI results for a
block that has transactions. Its `block` row is written (so the height is not a
gap) and nothing derived from results is; it never overwrites a good block.

### Tables

Heights `bigint`, amounts `numeric(78,0)` (come back as strings), times
`timestamptz`, addresses bech32 unless noted. Every table has `chain_id`.

**`tx`** — PK `(chain_id, hash)`. Existing columns unchanged. New in v4:
`memo`, `signers text[]` (every signer in order, from `acc_seq`),
`fee_granter`, `codespace` (with `code`, the failure reason), `fee_coins jsonb`
`[{"denom","amount"}]` (every fee coin; `fee_denom`/`fee_amount` keep the
first). `signer` stays the first signer / fee payer. `msg_types` now comes from
the transaction bytes when events are silent, so **failed transactions have
their types**. GIN index on `msg_types`: `WHERE msg_types @> ARRAY[$type]`.

**`transfer`** — one row per coin moved. **Key is now
`(chain_id, tx_hash, event_seq, coin_index)`** (`event_seq`: ordinal of the
event within the transaction); the old primary key is dropped. `msg_index` is
the top-level message (−1 for the fee, charged before any message runs), new
`authz_msg_index` is the position inside a MsgExec (null otherwise). `kind`:
`fee`, `transfer`, `reward`, `commission` — unchanged meanings, now correct
before the upgrade too. Zero-amount rows (the SDK's `0stake` empty reward) are
no longer written. A transaction's rows are replaced as a set, so a reader never
sees a half-rewritten transaction. Order a transaction's rows by `event_seq`.
Rows below the `transfers` coverage floor are version 3 and have
`event_seq IS NULL`. Since migration 013, `signer` is set on `commission` rows: the signer of the
withdrawing transaction (NULL on every other kind).

**`tx_party`** — who a transaction touched. PK
`(chain_id, address, height, tx_hash)`, `roles int` bitmask: 1 signer,
2 fee_payer, 4 fee_granter, 8 sender, 16 recipient, 32 delegator, 64 validator,
128 voter, 256 depositor, 512 proposer, 1024 granter (authz), 2048 grantee,
4096 relayer, 8192 other. Every bech32 account or operator address in the
transaction's events and messages, plus signers and fee payer/granter.
**Module accounts are excluded** (fee collector, distribution, bonded and
not-bonded pools, gov, mint, IBC transfer escrows): they are party to nearly
everything. Addresses of other chains that appear in IBC packets
(`osmo1…`) are included — they are parties too.

**`tx_msg`** — PK `(chain_id, tx_hash, msg_index, inner_index)`, from the
transaction's bytes: `type_url`, `sender` (the message's signer field; a
MultiSend's first input), `height`. `inner_index` −1 is the top-level message;
0.. are the messages inside a MsgExec at that `msg_index`. Failed transactions
included. Index `(chain_id, type_url, height DESC)`.

**`ibc_packet`** — one row per packet per direction, PK
`(chain_id, direction, src_port, src_channel, sequence)`. `direction` `out`
(sent here: `send_*`, then `ack_*` or `timeout_*` here) or `in` (received here:
`recv_*`, and the ack this chain wrote). `src_*` is always the packet's
**source** side, so an inbound packet's `src_channel` is the counterparty's.
Also `dst_port`, `dst_channel`, `connection_id`, `sender`, `receiver`, `denom`,
`amount`, `memo` (ICS-20 data), `timeout_height` (`rev-height`),
`timeout_timestamp`, `ack_ok`, `ack_error`, `recv_relayer`, `ack_relayer`,
`timeout_at_height`, `timeout_tx`. Columns fill in as the packet's events
arrive; a later event never erases an earlier column. Indexes on sender,
receiver, send_tx, recv_tx, ack_tx.

**`staking_event`** — PK `(chain_id, height, tx_hash, event_seq)`. `kind`:
`delegate`, `undelegate`, `redelegate`, `cancel_unbonding`, `create_validator`,
`edit_validator` (from transactions) and `complete_unbonding`,
`complete_redelegation` (end-block, `tx_hash = ''`, `event_seq` = ordinal in the
block's events). `validator` (source for redelegate), `validator_dst`,
`delegator`, `amount`, `denom`, `completion_time`, `creation_height`,
`msg_index`, `authz_msg_index`, `time`. Indexes by validator, validator_dst,
delegator (each with `height DESC`).

**`validator_power`** — PK `(chain_id, height, cons_addr)`; every
`validator_update`. `cons_addr` is uppercase hex like `block.proposer_cons` and
`missed_signature`; `power` 0 means the validator left the active set. Since
migration 013, `time` is the block's time.

**`validator_key`** — PK `(chain_id, operator)`: `cons_hex` (uppercase hex),
`cons_valcons` (bech32, as `slash_event.cons_addr`). From MsgCreateValidator and
the staking API. The join between operator and consensus identities.

**`slash_event`** — unchanged shape. v4 adds kinds `tombstoned` (double sign)
and `unjailed`, and fills `operator` where `validator_key` knows it. An unjail
names only the operator on chain; its `cons_addr` is the valcons once the key is
known (always, after a refill seeded from the staking API).

**`gov_proposal`** — PK `(chain_id, proposal_id)`: `submit_height`,
`submit_tx`, `submit_time`, `proposer`, `messages text[]`, `outcome`
(`passed` / `rejected` / `failed` / `dropped`), `outcome_height`,
`outcome_time`. Columns fill in independently.

**`gov_deposit`** — PK `(chain_id, tx_hash, event_seq)`: `proposal_id`,
`depositor`, `coins jsonb`, `height`, `time`. The initial deposit of a
submission is a row too.

**`vote_event`** — PK `(chain_id, tx_hash, event_seq)`: every vote as cast,
re-votes included, same columns as `vote`. `vote` keeps the final vote per
voter and gains nothing.

**`block_gap`** — PK `(chain_id, lo)`, `hi`, `reason` (`fetch`: the archive
could not serve it; `scan`: found by migration 010). osmosis-1 holds one
recorded gap, 69,638,977–69,768,594, below its contiguous range: deliberate
islands for the GATA reconcile — never delete them.

**`indexer_cursor`** — `last_height` (everything up to here is committed),
`updated_at`, new `head_height`.

### Freshness: `indexer_cursor.updated_at`

`updated_at` moves on **every committed follower batch**, and on a
**heartbeat** each poll where the follower is at the node's head with nothing
new (`last_height >= head`). So:

- `now() - updated_at` is **staleness**: > 2 min means the follower is stuck
  or its node is — fall back to the live path.
- `head_height - last_height` is **lag**: the follower is alive but behind.
- A backfill never moves the cursor.
- **gno chains** (`gnoland-1`, `onyx-1`) have cursor rows too, written by the
  gno follower. `head_height` is the node's head (from a non-validating node);
  the heartbeat fires only while the tx-indexer the follower reads is within
  10 blocks of that head, so a stalled tx-indexer shows up as a stale cursor,
  not as a fresh one with nothing new.

### What Scan reads, and how

Queries, not helpers: nothing is added to `lib/indexer-db.ts` by the indexer
session; Scan owns that file. Each read gates on its capability.

- **Transaction detail** (`tx`): `code`, `codespace`, `gas_used`,
  `gas_wanted`, `signers`, `memo`, `fee_coins`, `fee_granter`, `msg_types`;
  messages from `tx_msg ORDER BY msg_index, inner_index`; movements from
  `transfer ORDER BY event_seq, coin_index`.
- **Votes**: `vote` (final) with `tx_hash`, `height`, `time`; the full history
  of a voter's recasts from `vote_event`.
- **Account history** — replaces the `tx.signer ∪ transfer` union:

  ```sql
  SELECT p.height, p.tx_hash, p.roles, t.time, t.code, t.msg_types, t.fee_coins
    FROM tx_party p
    JOIN tx t ON t.chain_id = p.chain_id AND t.hash = p.tx_hash
   WHERE p.chain_id = $1 AND p.address = $2
     AND p.height BETWEEN $lo AND $hi            -- indexer_coverage(.., 'tx_party')
     AND (p.height, p.tx_hash) < ($before_height, $before_hash)   -- keyset; omit on page 1
   ORDER BY p.height DESC, p.tx_hash DESC
   LIMIT $n;
  ```

  Walks the primary key; no sort, no union. The amount for the list row is the
  account's `transfer` rows for that transaction (`kind <> 'fee'`). Until
  `tx_party` coverage reaches genesis, the old union still serves the range
  below it, and — after the refill — returns pre-upgrade incoming transfers it
  never had.
- **Staking history**: `staking_event` by `delegator` or `validator`
  (`height DESC`).
- **Missed blocks**: `missed_signature` by hex consensus address; join
  `validator_key.cons_hex` to go from an operator.
- **Slashing**: `slash_event`, now with `tombstoned` and `unjailed`.
- **IBC**: `ibc_packet` by `send_tx` / `recv_tx` / `ack_tx` for a transaction's
  packet, by `sender` / `receiver` for an account, by channel for a channel page.

### gno.land in our own database (migration 011)

Read from each chain's own tx-indexer (GraphQL: gnoland-1 on 127.0.0.1:8547,
onyx-1 on 8546; pearl-1, retired 2026-09-28, keeps its rows) by height range, from genesis, by the same `indexer.service`
(`INDEXER_GNO`). Blocks are written into `block` at the gno extract version: 4, and 5 since
migration 014 (messages and GRC20). A block whose
transaction count (`num_txs`) differs from what the tx-indexer returns for it is
written **hollow** (version 0): present, never covered.

**`gno_tx`** — PK `(chain_id, hash)`. `hash` is **uppercase hex** (the
tx-indexer's base64, decoded; `gnoHashToHex` gives the same), `height`,
`tx_index`, `time` (the block's), `success`, `gas_wanted`, `gas_used`,
`fee_amount` numeric, `fee_denom`, `msg_types text[]` (the tx-indexer's type
names: `BankMsgSend`, `MsgCall`, `MsgRun`, `MsgAddPackage`, `MsgEnablePackage`,
`MsgRejectPackage`), `memo`, `error` (the chain's text for a failed
transaction). Index `(chain_id, height DESC, tx_index)` for a block's or the
chain's latest transactions.

**`gno_tx_party`** — PK `(chain_id, address, height, tx_hash)`, `roles int`,
the same design as `tx_party` and the same bits where they mean the same:

| bit | role | from |
|---|---|---|
| 1 | signer | a message's signer: `BankMsgSend.from_address`, `MsgCall`/`MsgRun.caller`, `MsgAddPackage.creator`, `MsgEnablePackage.approver`, `MsgRejectPackage.sender` |
| 8 | sender | coins out: a bank send's from, a call or run that `send`s coins, a Transfer event's `from` |
| 16 | recipient | a bank send's to, a Transfer event's `to` |
| 16384 | creator | the deployer of a package |

Transfer events are GRC20 `GnoEvent`s of type `Transfer` (attrs `from`/`to`; a
mint's empty `from` is skipped) and the bank's `TransferEvent` (coins a realm
moved). A **failed** transaction keeps its signer only: its events describe
nothing that happened. Addresses are `g1…` (40 characters); realm addresses that
receive tokens are parties too.

### `address_tx_count` (migration 011)

PK `(chain_id, address)`: `tx_count bigint`, `first_height`, `last_height`,
`first_time`, `last_time`. One row per address that is party to at least one
transaction, for every chain: counted from `tx_party` (Cosmos) and
`gno_tx_party` (gno).

- **Maintained on write, by the database.** Statement-level triggers on both
  party tables add each *newly inserted* (address, transaction) row in the same
  transaction as the write. A refill re-writing rows counts nothing twice
  (`ON CONFLICT` updates are not inserts); a delete recounts the addresses it
  touched from scratch. Verified on the production-size copy: every address's
  count equals `count(*)` of its party rows (17,902 AtomOne/Cosmos addresses,
  1,889 gnoland-1, 7,415 pearl-1).
- **What it counts:** the address's transactions among the heights written at
  version 4. Every counted transaction is real, so it is always a **lower
  bound**, and it is **exact** when `indexer_coverage(chain, 'address_tx_count')`
  starts at the chain's first block. While a refill is still descending
  (AtomOne until the archive refill reaches genesis), say **"at least N"** and
  show the coverage `lo` as "since block lo / lo_time". Transactions at heights
  below `lo` that a refill already wrote are counted (they are real), so the
  count may include a little more than `lo..hi`, never less.
- `first_height`/`first_time` is the earliest counted transaction, not
  necessarily the account's first on chain until coverage reaches genesis.

### What Scan reads, and how (gno and counts)

Gate on coverage exactly as for `tx_party`:

```sql
-- the window the indexer vouches for
SELECT lo, hi, lo_time, hi_time FROM indexer_coverage($chain, 'gno_tx_party');

-- an account's history, newest first, keyset-paged (omit the tuple on page 1)
SELECT p.height, p.tx_hash, p.roles,
       t.time, t.success, t.msg_types, t.fee_amount, t.fee_denom, t.memo, t.error
  FROM gno_tx_party p
  JOIN gno_tx t ON t.chain_id = p.chain_id AND t.hash = p.tx_hash
 WHERE p.chain_id = $1 AND p.address = $2
   AND p.height BETWEEN $lo AND $hi
   AND (p.height, p.tx_hash) < ($before_height, $before_hash)
 ORDER BY p.height DESC, p.tx_hash DESC
 LIMIT $n;

-- "N transactions", first and last activity
SELECT tx_count, first_height, last_height, first_time, last_time
  FROM address_tx_count WHERE chain_id = $1 AND address = $2;
```

Measured on the production-size copy with g1juss2tuc97sr77rn6vprhh9lr7d9e07uu68x59
(32,003 transactions): first page 1.7 ms, a page 30,000 rows deep 1.7 ms (a
backward walk of the primary key, no sort), the count 0.13 ms. Below `lo` keep
the GraphQL windows. For Cosmos chains the count row is read the same way; its
capability is `address_tx_count` and its history stays `tx_party`.

**Other readers** — `app_ro`, `monitor` and `atomone_app_ro` read `block`,
`tx`, `transfer`, `missed_signature`, `slash_event`, `vote`. GATA Hub's
reconcile reads `transfer (tx_hash, time, to_addr, denom, amount, from_addr)`
with `kind = 'transfer'`: those columns and that meaning are unchanged, and
before 9,550,000 it now finds transfers that were stored as fees.
`app_ro`, `monitor` and `scan_ro` see new tables through default privileges;
`atomone_app_ro` has explicit grants only and gets none of them.

### Validator page reads (migration 013)

Scan's request of 2026-10-16, part A: every read of an AtomOne validator page
under about 100 ms, measured on production (atomone-1, 10.8M blocks) for DKCMC
(`atonevaloper144xw…`, 913,000 blocks proposed, 62 transactions signed) and
NodesHub (`atonevaloper1d3ha…`, a restake service: 47,187 transactions signed).

| read | before (first / warm) | after: the indexes alone, same query (first / warm) | after 013's rollup and columns |
|---|---|---|---|
| proposerStats | 2.8 s / 1.4 s | 0.33 s / 0.21 s DKCMC, 0.13 s / 83 ms NodesHub | `proposer_blocks()`: to be measured once 013 is applied |
| blockCount (chain-wide) | 1.1 s | | no query: `hi - lo + 1` |
| commissionEarned (NodesHub) | 14.4 s | 0.78 s / 0.15 s | `transfer.signer`: to be measured once 013 is applied |
| validatorEvents (NodesHub) | 5.2 s / 0.9 s | 7.7 ms / 7.0 ms | |
| validatorCreatedAt (NodesHub) | 1.1 s / 0.17 s | 0.4 ms / 0.2 ms | |
| powerEvents, 30-day flow (NodesHub) | 2.1 s | 74 ms / 69 ms (17 ms of it JIT) | JIT off for `scan_ro` |
| powerEvents, list | 0.57 s / 26 ms | the UNION ALL form below: 1.2 ms | |
| powerHistory | 0.17 s / 42 ms | 0.31 s / 52 ms DKCMC (plan unchanged) | `validator_power.time`: to be measured once 013 is applied |
| signing counts (NodesHub) | 0.13 s / 5 ms | 6.4 ms / 3.6 ms | |

"After: the indexes alone" was measured on production on 2026-10-16 at 22:28 UTC,
after the six new indexes were built (22:24 UTC), with Scan's queries unchanged.
First reads vary with what the cache holds; the warm figures are the comparable
ones. The rollup, the two copied columns and the role setting arrive with the
rest of migration 013.

Everything else measured under 35 ms: votes, recasts, commissionHistory,
slashHistory, stakeHistory, proposedBlocks.

**Indexes** (all built `CONCURRENTLY`; a replacement is built before the index it
replaces is dropped):

| index | serves | replaces |
|---|---|---|
| `block_proposer_time_idx` `(chain_id, proposer_cons, height DESC) INCLUDE (time)` | proposedBlocks, `proposer_blocks()`, the fairness window | `block_proposer_idx` |
| `tx_signer_height_idx` `(chain_id, signer, height DESC) INCLUDE (msg_types)` | validatorEvents, validatorCreatedAt, any read by signer | `tx_signer_idx` |
| `transfer_commission_idx` `(chain_id, tx_hash) INCLUDE (denom, amount, time)`, commission rows | validatorEvents' amounts | |
| `transfer_commission_signer_idx` `(chain_id, signer) INCLUDE (denom, amount, time)`, commission rows | commissionEarned | |
| `staking_event_validator_time_idx`, `staking_event_validator_dst_time_idx` `(…, time DESC)` | powerEvents' 30-day flow | |
| `missed_signature_cons_flag_idx` `(chain_id, cons_addr, height DESC) INCLUDE (flag)` | signing counts, days and runs | `missed_signature_validator_idx` |
| `validator_power_cons_time_idx` `(chain_id, cons_addr, height DESC) INCLUDE (power, time)` | powerHistory, the power before the window | `validator_power_cons_idx` |

**`block_proposer_count`**: PK `(chain_id, proposer_cons, bucket)`, `blocks int`,
where `bucket = height / 10000`. Blocks per proposer per 10,000 heights, kept by
statement-level triggers on `block` in the writer's own transaction: an insert
adds, an update that changes the proposer moves the count, a delete takes it
off, and a refill rewriting a block counts nothing twice. A bucket row exists
only while it counts at least one block. Read it through the function, which is
exact for any window: whole buckets from the table, the two partial ends from
`block_proposer_time_idx`.

```sql
-- blocks proposed by $cons (uppercase hex) with lo <= height <= hi, and the newest one
SELECT blocks, last_height, last_time FROM proposer_blocks($chain, $cons, $lo, $hi);
```

- **proposerStats**: `proposed, last_height, last_time` =
  `proposer_blocks(chain, cons, lo, hi)` with `lo`/`hi` from
  `indexer_coverage(chain, 'blocks')`.
- **blockCount**: no query. Coverage has no holes (no recorded gap, every height
  in `lo..hi` has its row), so the blocks in the run number `hi - lo + 1`
  (checked against `count(*)` on every chain, 2026-10-16).
- **proposerFairness**: a window `[lo, hi)` inside coverage holds `hi - lo`
  blocks, of which `proposer_blocks(chain, cons, lo, hi - 1).blocks` are the
  validator's. (`validator_stake` is empty on production today, so the window
  never forms.)

**`transfer.signer`**: on `commission` rows, the signer of the transaction
(`tx.signer`), set by a trigger from `tx` when the row is written (`tx` is written
first, and a transaction's transfers are always replaced together after it) and
filled by the migration for older rows. NULL on every other kind, and where the
transaction has no signer (the join matched nothing there either).

```sql
-- commissionEarned: same rows as the join on tx.signer, from one index
SELECT denom, sum(amount)::text AS total, count(*) AS n,
       min(time)::text AS first, max(time)::text AS last
  FROM transfer
 WHERE chain_id = $1 AND kind = 'commission' AND signer = $2
 GROUP BY denom
 ORDER BY sum(amount) DESC;
```

**`validator_power.time`**: the block's time, set by a trigger from `block` when
the row is written, filled by the migration for older rows.

```sql
-- powerHistory, without the join to block
SELECT height::text, power::text, time::text
  FROM validator_power
 WHERE chain_id = $1 AND cons_addr = $2 AND height BETWEEN $3 AND $4
 ORDER BY validator_power.height DESC
 LIMIT 2000;
```

**powerEvents**: `validator = $2 OR validator_dst = $2` cannot walk an index in
order, so the planner reads every event the validator ever had and sorts them.
As two ordered branches it reads at most 200 from each:

```sql
SELECT e.height::text AS height, e.tx_hash, e.time::text AS time, e.kind, e.validator,
       e.validator_dst, e.delegator, e.amount::text AS amount, e.denom,
       e.completion_time::text AS completion_time
  FROM ((SELECT * FROM staking_event
          WHERE chain_id = $1 AND validator = $2 AND height BETWEEN $3 AND $4
            AND kind NOT IN ('complete_unbonding', 'complete_redelegation')
          ORDER BY staking_event.height DESC, event_seq DESC LIMIT $5)
        UNION ALL
        (SELECT * FROM staking_event
          WHERE chain_id = $1 AND validator_dst = $2 AND validator IS DISTINCT FROM $2
            AND height BETWEEN $3 AND $4
            AND kind NOT IN ('complete_unbonding', 'complete_redelegation')
          ORDER BY staking_event.height DESC, event_seq DESC LIMIT $5)) e
 ORDER BY e.height DESC, e.event_seq DESC
 LIMIT $5;
```

The second branch's `validator IS DISTINCT FROM $2` keeps an event that names
the validator on both sides from being returned twice. Order by `e.height` (the
bigint), not by the `height` text output column. Same 200 rows in the same order
as the OR form for DKCMC and NodesHub, 1.2 ms against 13-26 ms warm and
0.2-0.6 s cold. The 30-day flow keeps its OR form: the two time indexes serve it.

**Scan's role**: `scan_ro` has `jit = off` in this database (set per database, as
a role is cluster-wide). Scan's reads are short index lookups, and when the
planner overestimates one its cost crosses `jit_above_cost` and LLVM compiles the
plan first: 16 to 290 ms before a 5 ms read. New connections pick it up.

**Capabilities** `proposer_count` (0), `commission_signer` (4),
`validator_power_time` (4) cover what their sources cover (`blocks`,
`transfers`, `validator_power`); until migration 013 has run they return no row,
so a reader gating on them keeps its old query.

### gno.land messages and GRC20 tokens (migration 014)

Scan's request of 2026-10-16, part B. Scan read both from the tx-indexer's
GraphQL: 1-6 s a query, capped at 10,000 transactions, and every token's state
rebuilt in memory at each boot. Written by the gno follower at **gno extract
version 5**; history is rewritten by the gno refill (below). Gate on
`indexer_coverage(chain, 'gno_tx_msg')` and `indexer_coverage(chain,
'gno_grc20')`, and ask these only for gno chains: gno and Cosmos versions are
numbered separately, so a Cosmos chain at version 5 answers too.

**Genesis.** Height 0 holds the genesis transactions (gnoland-1: 96, onyx-1:
93; wugnot is created there). The tx-indexer answers nothing at all to a
negative `gt` bound, so a window that starts at 0 is bounded above only
(`{lt: hi + 1}`), and a chain with no cursor now starts at 0. gnoland-1 already
held block 0; onyx-1's arrives with the refill, and its coverage then starts at 0.

**The 10,000 cap.** The tx-indexer now refuses a window over 10,000 rows with an
error ("max elements per query reached", plus the first 10,000) where it used to
cut the list short silently. The follower took the error for a failure and would
have retried that window forever; blocks and transactions now split the window
until each part fits.

**`gno_tx_msg`**: PK `(chain_id, tx_hash, msg_index)`, one row per message:
`height`, `success`, `kind`, `pkg_path`, `func`, `caller`, `args text[]`.
`msg_index` is the message's place in the transaction.

| kind | message | caller | pkg_path |
|---|---|---|---|
| `call` | MsgCall | `caller` | the realm called; `func` and `args` too |
| `run` | MsgRun | `caller` | NULL: the chain assigns a run's path, its transaction names none |
| `addpkg` | MsgAddPackage | `creator` | the package deployed |
| `enable` | MsgEnablePackage (an approval) | `approver` | the package approved |
| `reject` | MsgRejectPackage | `sender` | the package rejected |
| `send` | BankMsgSend | `from_address` | NULL |

Failed transactions are included (`success` false). Session messages
(`create_session`, `revoke_session`, typed `UnexpectedMessage` by the
tx-indexer) have no row, although the tx-indexer's MsgCall `pkg_path` filter
matches them. An approval is `enable`, never `call`. Each argument is cut to 200
characters, an ellipsis marking the cut. Indexes:
`(chain_id, pkg_path, height DESC, tx_hash DESC, msg_index DESC) INCLUDE (kind)`,
`(chain_id, caller, height DESC)`, and the `addpkg` rows by `(chain_id, pkg_path)`
with `caller, height, tx_hash, success`.

```sql
-- a realm's calls, newest first, keyset-paged (omit the tuple on page 1)
SELECT tx_hash, msg_index, height, success, func, caller, args
  FROM gno_tx_msg
 WHERE chain_id = $1 AND pkg_path = $2 AND kind = 'call'
   AND (height, tx_hash, msg_index) < ($h, $t, $i)
 ORDER BY height DESC, tx_hash DESC, msg_index DESC
 LIMIT $n;

-- how many calls a realm has had
SELECT count(*) FROM gno_tx_msg WHERE chain_id = $1 AND pkg_path = $2 AND kind = 'call';

-- the deployer of a package (of every package: drop the pkg_path condition)
SELECT pkg_path, caller AS deployer, height, tx_hash
  FROM gno_tx_msg
 WHERE chain_id = $1 AND kind = 'addpkg' AND success AND pkg_path = $2;

-- approvals
SELECT pkg_path, caller AS approver, height, tx_hash, success
  FROM gno_tx_msg
 WHERE chain_id = $1 AND kind = 'enable'
 ORDER BY height DESC;
```

**GRC20.** From the `GnoEvent`s whose `pkg_path` is `gno.land/p/nt/grc20/v0`:
every GRC20 token is built on that package and it emits on the token's behalf,
so the event names the package, not the realm. GRC721 collections emit a
`NewToken` too, from their own packages (on gnoland-1, 19 from
`gno.land/p/nt/grc721/v0` and 2 from a user's), and are not here. Successful
transactions only.

**`gno_grc20_token`**: PK `(chain_id, token)`. `token` is the key the events
carry, `<realm>.<SYMBOL>.<sequence in hex>` (`gno.land/r/gnoswap/gns.GNS.0000000`);
`realm` is the key less symbol and sequence; `name`, `symbol`, `decimals`,
`created_height`, `created_tx`.

**`gno_grc20_transfer`**: PK `(chain_id, tx_hash, event_index)`: `height`,
`token`, `from_addr` (`''` for a mint), `to_addr` (`''` for a burn), `amount`
numeric. `event_index` is the event's place among all the transaction's events.
Indexes `(chain_id, token | from_addr | to_addr, height DESC, tx_hash DESC,
event_index DESC)`.

**`gno_grc20_balance`**: PK `(chain_id, token, address)`, `balance`: what came
in minus what went out over the stored transfers, kept by statement-level
triggers in the writer's transaction (an insert adds, an update moves the
difference, a delete takes it off; re-reading an unchanged event changes no row
and moves nothing). A row exists only while its balance is not zero, so a
token's holders are its rows. Exact when `gno_grc20` coverage starts at the
chain's first block; while the refill is still descending, a balance can be
partial, even negative.

```sql
-- the token list: holders and supply
SELECT t.token, t.realm, t.name, t.symbol, t.decimals, t.created_height,
       count(b.address) AS holders, COALESCE(sum(b.balance), 0) AS supply
  FROM gno_grc20_token t
  LEFT JOIN gno_grc20_balance b ON b.chain_id = t.chain_id AND b.token = t.token
 WHERE t.chain_id = $1
 GROUP BY t.chain_id, t.token;

-- transfers per token
SELECT token, count(*) AS transfers FROM gno_grc20_transfer WHERE chain_id = $1 GROUP BY token;

-- holders, ranked
SELECT address, balance FROM gno_grc20_balance
 WHERE chain_id = $1 AND token = $2
 ORDER BY balance DESC
 LIMIT $n;

-- a token's transfers, keyset-paged
SELECT height, tx_hash, event_index, from_addr, to_addr, amount
  FROM gno_grc20_transfer
 WHERE chain_id = $1 AND token = $2 AND (height, tx_hash, event_index) < ($h, $t, $e)
 ORDER BY height DESC, tx_hash DESC, event_index DESC
 LIMIT $n;

-- an account's balances
SELECT token, balance FROM gno_grc20_balance WHERE chain_id = $1 AND address = $2;

-- an account's transfers, both sides, keyset-paged
SELECT e.* FROM (
  (SELECT height, tx_hash, event_index, token, from_addr, to_addr, amount FROM gno_grc20_transfer
    WHERE chain_id = $1 AND from_addr = $2 AND (height, tx_hash, event_index) < ($h, $t, $e)
    ORDER BY height DESC, tx_hash DESC, event_index DESC LIMIT $n)
  UNION ALL
  (SELECT height, tx_hash, event_index, token, from_addr, to_addr, amount FROM gno_grc20_transfer
    WHERE chain_id = $1 AND to_addr = $2 AND from_addr <> $2 AND (height, tx_hash, event_index) < ($h, $t, $e)
    ORDER BY height DESC, tx_hash DESC, event_index DESC LIMIT $n)) e
 ORDER BY e.height DESC, e.tx_hash DESC, e.event_index DESC
 LIMIT $n;
```

The second branch's `from_addr <> $2` keeps a transfer to oneself from coming
back twice.

**Checked against the chain** (gnoland-1: every height from 0 to 856,672
written by the refill into a scratch database, 2026-10-16):

- 32 tokens, 31 of them created by the end of 2026-10-14 (FISH followed on
  10-15): Scan's count that day.
- GNS supply 118,737,756,333,652, wugnot supply 5,558,432,268,709 and the GNS
  of the pool `g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v`, 30,585,601,489,055:
  each equal to the chain's own `TotalSupply()` / `BalanceOf()` at the same head,
  checked twice.
- Scan's 2026-10-14 figures are running totals of this history: GNS supply
  117,228,231,546,427, the pool's 29,379,944,283,881 and wugnot's
  5,079,879,553,812 all held at block 798,302 (12:05 UTC).
- The 27 tokens Onbloc lists match on holders and on supply, all 27. The 5 more
  here are ones Onbloc does not list (FISH, two demo FOOs, PRB, abt).
- No negative balance, and no transfer of a token without its `NewToken`.

Measured on that copy (busiest realm: 13,215 calls; busiest token account:
35,928 transfers): a realm's calls 0.3 ms (any page), their count 12 ms, every
package's deployer 1 ms, approvals 18 ms (a scan of `gno_tx_msg`), the token list
2 ms, transfers per token 40 ms, holders ranked 0.2 ms, a token's or an account's
transfers 0.3 ms (page 1 or 20,000 deep), an account's balances 0.1 ms. For
gnoland-1, `gno_tx_msg` is 185,549 rows (39 MB, 95 MB of indexes) and
`gno_grc20_transfer` 87,074 (21 MB, 79 MB); 1,041 of 80,676 calls (1.3%) have an
argument cut, and no call had more than 14 arguments.

**The gno refill** (`npm run indexer:gno-refill`, `indexer/src/gno-refill-cli.ts`)
rewrites a chain's stored history at the current gno version, downwards from the
cursor to genesis, beside the follower. One request at a time with a pause after
each; a range whose blocks all carry the current version is skipped without a
read, so a stopped refill resumes where it left off; heights the tx-indexer has
no block for are recorded as gaps, as the follower does; the cursor is never
touched.

| variable | meaning |
|---|---|
| `DATABASE_URL` | the database |
| `GNO_REFILL_CHAIN` | `gnoland-1` or `onyx-1` |
| `GNO_REFILL_GRAPHQL` | the chain's tx-indexer, the one the follower reads (8547, 8546) |
| `GNO_REFILL_FROM` | highest height (default: the chain's cursor) |
| `GNO_REFILL_FLOOR` | lowest height (default 0, genesis) |
| `GNO_REFILL_BATCH` | heights per range (default 1000; up to 5000 keeps each read under the cap) |
| `GNO_REFILL_THROTTLE_MS` | pause after each request (default 500) |

Deploy order: apply 013 and 014, deploy the release (the follower then writes
version 5 from the head), then run the refill once per gno chain.

The whole of gnoland-1 (856,593 heights, 161,885 transactions) took 4.5 minutes
at 10,000-height ranges with a 600 ms pause after each request. Run it like the
Cosmos backfill: a one-off job beside the follower, with the follower's
`DATABASE_URL`.

## Schema

> The original design. Superseded where it differs from the contract above.

Types are Postgres. `chain_id` is on every table so one database serves all
chains. All heights are `bigint`, all token amounts are `numeric(78,0)` (base
denom, integer — big enough for any Cosmos supply), all times are
`timestamptz`.

### `block`
The chain's spine.

| column | type | notes |
|---|---|---|
| chain_id | text | PK part |
| height | bigint | PK part |
| time | timestamptz | |
| proposer_cons | text | consensus address (hex) |
| hash | text | |
| tx_count | int | |

Index: `(chain_id, time)`.

### `tx`
One row per transaction — **fields, not the raw body.**

| column | type | notes |
|---|---|---|
| chain_id | text | PK part |
| hash | text | PK part |
| height | bigint | FK-ish to block |
| tx_index | int | position in block |
| code | int | 0 = success |
| fee_denom | text | |
| fee_amount | numeric(78,0) | |
| gas_used | bigint | |
| gas_wanted | bigint | |
| memo | text | |
| signer | text | first signer / fee payer |
| msg_types | text[] | for the type pills |

Indexes: `(chain_id, height)`, `(chain_id, signer)`.

### `transfer`
Value movements, unwrapped from authz. This powers account history and the
Amount column without re-parsing.

| column | type | notes |
|---|---|---|
| chain_id | text | |
| tx_hash | text | |
| msg_index | int | |
| kind | text | send / delegate / undelegate / redelegate / reward / ibc |
| from_addr | text | delegator or sender; validator for undelegate |
| to_addr | text | recipient; validator for delegate |
| denom | text | |
| amount | numeric(78,0) | |

PK `(chain_id, tx_hash, msg_index)`. Indexes: `(chain_id, from_addr)`,
`(chain_id, to_addr)`. This is the one table that can grow with usage; see
Retention.

### `vote`
Latest vote per voter per proposal, so a tallied proposal is one indexed query
instead of tens of tx-search pages. Authz-unwrapped (the granter is the voter).

| column | type | notes |
|---|---|---|
| chain_id | text | PK part |
| proposal_id | bigint | PK part |
| voter | text | PK part — account address |
| option | text | heaviest option |
| weighted | bool | |
| options | jsonb | full split for weighted votes |
| height | bigint | of the latest vote tx |
| tx_hash | text | |

PK `(chain_id, proposal_id, voter)` — upsert on re-vote keeps only the last.

### `slash_event`
Jail, unjail, tombstone, and slash — the history no node keeps. From
`block_results` events (`slash`, `liveness`) plus staking `EventValidator...`.

| column | type | notes |
|---|---|---|
| id | bigserial | PK |
| chain_id | text | |
| cons_addr | text | consensus address |
| operator | text | resolved valoper, when known |
| height | bigint | |
| time | timestamptz | |
| kind | text | jailed / unjailed / tombstoned / slashed |
| reason | text | downtime / double_sign |
| burned | numeric(78,0) | slashed amount, when present |

Index: `(chain_id, cons_addr, height)`. Tiny table — these are rare.

### `validator_snapshot`
Periodic, **not per block** — one sample per validator per interval (say hourly).
Powers the 24h delta, uptime history, and stake/commission charts.

| column | type | notes |
|---|---|---|
| chain_id | text | PK part |
| operator | text | PK part |
| height | bigint | PK part |
| time | timestamptz | |
| tokens | numeric(78,0) | |
| commission | numeric | rate 0–1 |
| jailed | bool | |
| status | text | bonded / unbonding / unbonded |
| missed_window | bigint | slashing missed-block counter at this sample |

PK `(chain_id, operator, height)`. Index `(chain_id, time)`. Retained at
declining resolution (see Retention).

### `indexer_cursor`
Resume point and freshness signal for the read path.

| column | type | notes |
|---|---|---|
| chain_id | text | PK |
| last_height | bigint | last fully-committed height |
| updated_at | timestamptz | drives the fallback decision |

### What we deliberately do **not** store

- **Raw transaction JSON** for all history — the size bomb. We keep extracted
  fields and transfers; the rare "show me the raw tx" can hit the node live for
  recent heights.
- **Per-block signatures for all history** — storing who signed every block is
  huge. Uptime beyond the window comes from periodic `missed_window` snapshots;
  the recent ping-style bars stay a live read of the last ~20 blocks.
- **Account balances** — that is current state, which the node serves fine.

## Worker design

A single Node/TypeScript process (shares the repo's language and types),
per-chain loop:

1. **Follow the head.** Poll `/block` for the latest height (or subscribe to
   `NewBlock` over the RPC WebSocket). For each height above the cursor:
2. **Fetch** `/block` and `/block_results` for that height.
3. **Extract** in one pass: block row, tx rows, transfers (authz-unwrapped),
   votes, slash/liveness events. Reuse Scan's existing parsers
   (`lib/tx-parties.ts`, `lib/proposals.ts` authz flattening) — same logic,
   moved server-side.
4. **Write one height per transaction**, then advance `indexer_cursor` in the
   same transaction. Idempotent: everything upserts on its primary key, so
   replaying a height is safe.
5. **Snapshots** run on a separate timer (hourly), reading the validator set
   once and inserting `validator_snapshot` rows — not tied to the block loop.

Notes:

- **No reorg handling needed.** Tendermint/CometBFT commits are final — there is
  no fork to unwind once a block is committed. Index committed heights only
  (the head, not a pending block).
- **Catch-up is the same code path** as following — just a wider gap between
  cursor and head. Batch a few hundred heights, keep transactions small.
- **Gentle on the node.** The ongoing feed is ~one request per block against the
  local validator over localhost — negligible load. Backfill's heavy traffic
  stays off it (public archives instead).
- **Crash-safe.** On restart, resume from `indexer_cursor`. Because the node
  keeps a few-days buffer, a long outage still catches up without an archive.

## Backfill (history before indexing starts)

Following the head gives history *from now on*. To get the past — old proposals'
votes, historical slash events, a stake chart that predates the indexer — replay
old `/block_results` from a **public archive/full node once** (off our
validator), write into the same tables, then stop. **Depth (settled):** genesis
for AtomOne mainnet and testnet; **~1 year** for Cosmos Hub and Akash.

> **As built, this indexes AtomOne mainnet and nothing else.** Checked against
> the database on 2026-08-14: `atomone-1` only — 9.37M blocks from height
> 510,636 to the head, 8 GB, with the backfill still descending toward genesis
> at ~33 heights/sec. No Cosmos Hub, no Akash, no AtomOne testnet, no gno.land.
>
> The depths above are therefore a plan, not a description. The scan reads the
> index only for chains marked `indexed` in their chain config — currently
> `atomone-1` alone — so pointing the indexer at another chain means indexing it
> *and* setting that flag; doing either alone changes nothing.

**Requirement:** the archive must serve historical `/block_results` — i.e. it
kept ABCI responses (`discard_abci_responses = false`). Not every "archive" node
does; verify before relying on one.

### Sources found

**Cosmos Hub (`cosmoshub-4`)**
- **CryptoCrew public archive** (AADAO grant-funded), full history from
  `cosmoshub-4` genesis: `https://rpc.cosmoshub-main.ccvalidators.com:443`.
  Free, ~5 req/s public rate limit — throttle the backfill to match.
- PublicNode RPC gateway: `https://cosmos-rpc.publicnode.com` (verify
  block_results retention).
- Quicknode archive (paid) covers from block 5200791 (`cosmoshub-4` genesis).
- Note: `cosmoshub-1/2/3` are separate prior chains; Scan only cares
  about `cosmoshub-4`, so genesis-of-4 is the real start.

**AtomOne (`atomone-1`)**
- **Public archive found and verified:** Citizen Web3's
  `https://rpc.atomone-archive.citizenweb3.com:443`. Confirmed serving from
  `earliest_block_height: 1` (genesis) to head, and — the part that matters —
  `/block_results?height=1` returns the begin/finalize block events, so it keeps
  ABCI responses. This is directly usable for backfill; throttle politely.
- Alternatively, the chain is young (2024) so a **full node from genesis is
  cheap** to run on the box with `discard_abci_responses = false`. Genesis:
  `https://atomone.fra1.digitaloceanspaces.com/atomone-1/genesis.json`. Other
  endpoints and seeds: `cosmos.directory/atomone`, Polkachu.

**Akash (`akashnet-2`)**
- Snapshots from Polkachu (`https://akash-rpc.polkachu.com`) and ChainLayer
  Quicksync, but those are pruned, not archive. For full history either run a
  `pruning=nothing` node from a genesis/quicksync archive tier, or backfill only
  as far as a retained snapshot allows. Akash has had several upgrade heights
  (v0.10 → v0.14 → …) — replay must cross them, which a from-genesis node
  handles automatically.

**AtomOne testnet (`atomone-testnet-1`)** — young, so backfill from genesis via
its own public endpoints (`cosmos.directory/atomone-testnet`, Polkachu testnet).

**gno.land testnet (`sapphire-1`)** — not Cosmos SDK. No `/block_results` events to
mine; it yields blocks and txs only, read through its RPC + indexing API the
same way Scan's gno adapter already does. Backfill depth here is just
"as far as its public indexing API serves." A future gno.land **mainnet** slots
in the same way.

**Practical order:** AtomOne (mainnet + testnet) first — cheapest, and the
network GATA cares most about. Cosmos Hub ~1yr via the CryptoCrew archive. Akash
~1yr as a snapshot allows. gno.land last, blocks/txs only.

## Retention and size

Bounded by design:

- `block`, `tx`, `slash_event`, `vote` — grow with chain activity but slowly;
  votes and slashes are small. Keep indefinitely.
- `transfer` — the largest, grows with transaction volume. **Kept full,
  indefinitely** for now; add a thinning policy only if it actually grows large.
- `validator_snapshot` — the one to actively manage. Hourly × ~200 validators ×
  chains adds up. **Declining resolution:** hourly for 7 days, daily beyond,
  weekly past a year. A retention job rolls old rows up. Keeps it to hundreds of
  MB, not GB.

Rough steady-state estimate with selective indexing: **single-digit to
low-double-digit GB across all chains for years** — comfortably on the box, and
nowhere near the chain's terabytes.

## Read path (scan side)

A new adapter reads Postgres, chosen per-query behind the existing
`ChainAdapter` seam so pages do not change:

- **Freshness gate.** If `indexer_cursor.updated_at` is stale (say > 2 minutes
  behind wall clock) or the relevant table is empty for the chain, **fall back
  to the live path** already in `lib/*`. Scan never regresses.
- Roll out per feature: point votes at Postgres first (biggest win), then
  slash/uptime history, then charts. Each falls back independently.
- The existing `cached()` layer still sits in front, so even Postgres reads are
  coalesced.

## Deployment and isolation

Mirrors `deploy/`:

- **Postgres in a pinned-version Docker container**, published on `127.0.0.1`
  only, data on a named volume backed by a host path outside the release tree.
  Pinning the tag makes the setup reproducible and upgrades a deliberate act.
- Dedicated `indexer` system user for the worker; the database has a
  least-privilege **read-only** role that Scan connects as.
- systemd: `indexer.service` (the worker, `Restart=always`), and the Postgres
  container managed by systemd or its own compose unit; same hardening flags as
  `scan.service` (`ProtectSystem=strict`, `NoNewPrivileges`, …) on the
  worker.
- **Never touch `gata-hub`** — separate user, directory, and unit, per the
  standing rule.
- **Backups:** nightly `pg_dump` to a path outside the release tree. The
  projection is rebuildable from chain history, but a backup saves re-backfilling.

## Rollout phases

1. **Postgres container + schema + worker skeleton**, cursor + block/tx/transfer,
   following the head on AtomOne only. Prove the loop and idempotency.
2. **Votes** into Postgres + read-path fallback for the vote list. Immediate,
   visible win (30s → milliseconds).
3. **Slash/jail history** — the feature no node can provide. New "Jailed N
   times" and a slash timeline on validator pages.
4. **Snapshots** — 24h delta from Postgres (unblocks aggressive node pruning),
   then uptime history and stake/commission charts.
5. **Backfill** to the settled depths (AtomOne genesis; Cosmos Hub, Akash ~1yr),
   then the testnets; gno.land last, blocks/txs only.

## Deferred

Not decisions to make now, but worth naming:

- **Which validator node** the worker reads for each chain, and confirming
  `discard_abci_responses = false` on it so the few-days buffer is usable.
- **gno.land extraction detail** — its indexing API differs from Cosmos; the
  block/tx tables are shared but the reader is the gno path, and it populates no
  event tables.
- **A `transfer` thinning policy**, only if the table actually grows large.
