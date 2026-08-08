# Indexer

A companion service that turns the chains' live feed into a small, queryable
history in Postgres, so the explorer can answer questions no node can: jail and
slash history, uptime beyond the signing window, fast vote and delegator
queries, and trends over time.

Status: **spec, not yet built.** This document is the plan to review before any
code lands.

## Why

Some facts an explorer wants are simply not answerable from a node:

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
3. **Never worse than today.** The explorer reads Postgres first and falls back
   to the existing live-node path when the indexer lags or a table is empty.
   Shipping the indexer must not be able to break a working page.
4. **Isolated, like the explorer.** Own system user, own database, own systemd
   unit, localhost only. Same posture as `deploy/` — see
   [ARCHITECTURE.md](ARCHITECTURE.md) and the isolation rule the explorer
   already follows.

## Architecture

```
 companion full node (pruned, few-days block buffer)
        │  RPC on localhost: /block, /block_results
        ▼
 indexer worker  ── follows head, extracts events + periodic snapshots
        │  writes
        ▼
 Postgres (localhost)  ── the projection
        │  reads (localhost, sub-ms)
        ▼
 explorer  ── Postgres first, live-node fallback when the cursor lags
```

**Read from a companion full node, not the validator.** Heavy indexer queries
must not disturb consensus on the validating node. Use a separate non-validating
full node on the box (or read the validator gently if a companion is not
available). The node's own uptime incentive makes it a reliable local source —
that was the point of keeping this on the box.

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

## Schema

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
   votes, slash/liveness events. Reuse the explorer's existing parsers
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
- **Gentle on the node.** Bounded concurrency, localhost so no network cost, and
  it is a companion node whose only job is to be read.
- **Crash-safe.** On restart, resume from `indexer_cursor`. Because the node
  keeps a few-days buffer, a long outage still catches up without an archive.

## Backfill (history before indexing starts)

Following the head gives history *from now on*. To get the past — old proposals'
votes, historical slash events, a stake chart that predates the indexer — replay
old `/block_results` from an **archive source once**, write into the same
tables, then discard the archive. Decide depth per feature: forward-only is fine
for jail-going-forward and new-proposal votes; charts and old-proposal votes
need backfill.

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
- Note: `cosmoshub-1/2/3` are separate prior chains; the explorer only cares
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

**Practical order:** AtomOne is the cheapest to backfill fully (small, young),
and it is the network GATA cares most about — start there. Cosmos Hub uses the
CryptoCrew archive. Akash backfills as far back as a snapshot allows unless a
full archive is stood up.

## Retention and size

Bounded by design:

- `block`, `tx`, `slash_event`, `vote` — grow with chain activity but slowly;
  votes and slashes are small. Keep indefinitely.
- `transfer` — the largest, grows with transaction volume. Options if it grows:
  keep full for N months, then thin to staking/large transfers, or drop the
  oldest. Decide a policy; it is not urgent early.
- `validator_snapshot` — the one to actively manage. Hourly × ~200 validators ×
  chains adds up. **Declining resolution:** hourly for 7 days, daily beyond,
  weekly past a year. A retention job rolls old rows up. Keeps it to hundreds of
  MB, not GB.

Rough steady-state estimate with selective indexing: **single-digit to
low-double-digit GB across all chains for years** — comfortably on the box, and
nowhere near the chain's terabytes.

## Read path (explorer side)

A new adapter reads Postgres, chosen per-query behind the existing
`ChainAdapter` seam so pages do not change:

- **Freshness gate.** If `indexer_cursor.updated_at` is stale (say > 2 minutes
  behind wall clock) or the relevant table is empty for the chain, **fall back
  to the live path** already in `lib/*`. The explorer never regresses.
- Roll out per feature: point votes at Postgres first (biggest win), then
  slash/uptime history, then charts. Each falls back independently.
- The existing `cached()` layer still sits in front, so even Postgres reads are
  coalesced.

## Deployment and isolation

Mirrors `deploy/`:

- Dedicated `indexer` system user; Postgres as its own service, **listening on
  localhost only**; database owned by a role the explorer reads with a
  least-privilege (read-only) user.
- systemd: `indexer.service` (the worker, `Restart=always`) and a
  `postgres`/managed service; same hardening flags as `explorer.service`
  (`ProtectSystem=strict`, `NoNewPrivileges`, etc.).
- **Never touch `gata-hub`** — separate user, directory, and unit, per the
  standing rule.
- **Backups:** nightly `pg_dump` to a path outside the release tree. The
  projection is rebuildable from chain history, but a backup saves re-backfilling.

## Rollout phases

1. **Schema + worker skeleton**, cursor + block/tx/transfer, following the head
   on AtomOne only. Prove the loop and idempotency.
2. **Votes** into Postgres + read-path fallback for the vote list. Immediate,
   visible win (30s → milliseconds).
3. **Slash/jail history** — the feature no node can provide. New "Jailed N
   times" and a slash timeline on validator pages.
4. **Snapshots** — 24h delta from Postgres (unblocks aggressive node pruning),
   then uptime history and stake/commission charts.
5. **Backfill** each chain to the agreed depth; Akash last.

## Open decisions

- **Backfill depth per chain** — genesis for AtomOne (cheap); how far for Cosmos
  Hub and Akash?
- **Companion node** — stand up dedicated non-validating full nodes for the
  indexer to read, or read existing nodes gently?
- **Postgres** — managed by the OS package, or a pinned container? (Either fits
  the isolation rule; container is easier to reproduce.)
- **`transfer` retention policy** — full forever, or thin after N months?
