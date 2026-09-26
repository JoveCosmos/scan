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

returns the contiguous run of blocks ending at the newest one in which every
block carries the capability: no recorded gap (`block_gap`) and no block written
by an older extractor. No row means "not covered — use the live path". ~5 ms on
the production-size copy; Scan's 30 s cache is plenty. A refill descends from
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
`event_seq IS NULL`.

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
`missed_signature`; `power` 0 means the validator left the active set.

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

**Other readers** — `app_ro`, `monitor` and `atomone_app_ro` read `block`,
`tx`, `transfer`, `missed_signature`, `slash_event`, `vote`. GATA Hub's
reconcile reads `transfer (tx_hash, time, to_addr, denom, amount, from_addr)`
with `kind = 'transfer'`: those columns and that meaning are unchanged, and
before 9,550,000 it now finds transfers that were stored as fees.
`app_ro`, `monitor` and `scan_ro` see new tables through default privileges;
`atomone_app_ro` has explicit grants only and gets none of them.

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
