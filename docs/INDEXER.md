# Indexer

A companion service that turns the chains' live feed into a small, queryable
history in Postgres, so Scan can answer questions no node can: jail and
slash history, uptime beyond the signing window, fast vote and delegator
queries, and trends over time.

Status: **phase 1 built** (`indexer/`) — blocks, transactions and transfers,
following the head. Nothing in Scan reads Postgres yet; that is phase 2.
Later phases below are still plan.

Two things phase 1 settled that the plan had left open:

- **No transaction index needed.** A tx hash is `sha256(raw bytes)`, derived
  locally from the block and verified against the chain, so `tx_index: off` is
  fine.
- **No protobuf decoding needed.** The ABCI events carry *more* than the
  messages: a reward withdrawal's amount exists only in the event, and
  authz-wrapped transfers appear without unwrapping. So the schema's `transfer`
  table is populated from events, and the worker's only dependency is `pg`.

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
