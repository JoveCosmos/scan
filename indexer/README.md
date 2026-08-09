# Indexer — phase 1

Follows each chain's head and writes blocks, transactions and transfers into
Postgres. Design and later phases: [../docs/INDEXER.md](../docs/INDEXER.md).

Phase 1 deliberately does **not** touch the explorer's read path — nothing the
site renders changes yet. It builds the pipeline and proves it, so phase 2 can
point the vote list at Postgres behind a fallback.

## What it reads

Only two RPC calls per height, `/block` and `/block_results`. That means:

- **No transaction index required.** A tx hash is `sha256(raw bytes)`, derived
  locally — verified against the chain, so a node with `tx_index: off` works.
- **No protobuf decoding.** ABCI events carry more than the messages do: a
  reward withdrawal's amount exists *only* in the event, and authz-wrapped
  transfers appear without unwrapping.

## Local setup

```bash
cd indexer
cp .env.example .env        # set POSTGRES_PASSWORD
docker compose up -d
```

Then apply the schema:

```bash
npm run indexer:migrate
```

Postgres binds `127.0.0.1:5433` by default so it cannot collide with an
existing install, and keeps data in a Docker-managed named volume
(`indexer_pgdata`).

**No bind mounts, deliberately.** Snap-packaged Docker cannot mount anything
under `/srv`, and a box may run the snap for other workloads. So the data lives
in a named volume and the schema is piped in over stdin by `migrate.sh` rather
than mounted into `docker-entrypoint-initdb.d`. It is re-runnable — every
statement is `CREATE ... IF NOT EXISTS`.

Run the worker from the repo root:

```bash
DATABASE_URL=postgres://indexer:PASSWORD@127.0.0.1:5433/gata_indexer \
INDEXER_CHAINS=atomone-1=https://rpc.atomone-archive.citizenweb3.com \
npm run indexer
```

On a fresh cursor it starts at the **head**, so it will not silently try to
replay the whole chain. To start lower, set `INDEXER_START=9800000`.

## Environment

| variable | meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `INDEXER_CHAINS` | `chainId=rpcUrl` pairs, comma separated |
| `INDEXER_START` | optional height to begin at when the cursor is empty |

On the server, point `INDEXER_CHAINS` at the **local validator node**
(`http://127.0.0.1:26657`) — the ongoing feed is about one request per block, so
it does not disturb consensus. Backfill is the heavy part and runs against
public archives instead; see the spec.

## Checking it works

```sql
SELECT chain_id, last_height, updated_at FROM indexer_cursor;
SELECT count(*) FROM block;
SELECT hash, height, fee_amount, fee_denom, array_length(msg_types,1) AS msgs
  FROM tx ORDER BY height DESC LIMIT 5;
SELECT kind, count(*) FROM transfer GROUP BY kind;
```

`updated_at` is what the explorer's read path will gate on in phase 2: if it
falls behind, pages fall back to reading the chain live.

## Tests

Extraction is tested against a real captured AtomOne block, no network needed:

```bash
npx vitest run tests/indexer-extract.test.ts
```

The database tests need a throwaway Postgres and skip without one:

```bash
INDEXER_TEST_DATABASE_URL=postgres://indexer:PASSWORD@127.0.0.1:5433/gata_indexer \
  npx vitest run tests/indexer-db.test.ts
```

They cover the properties crash recovery depends on: replaying a height is
idempotent, the cursor never moves backwards, and amounts survive at full
integer width.

## Deploying

`indexer.service` mirrors the explorer's unit — dedicated `indexer` user, strict
filesystem isolation, `gata-hub` explicitly out of reach, and `Nice=10` /
`IOSchedulingClass=idle` so background indexing never crowds out the node.

Secrets go in `/etc/gata/indexer.env` (root:indexer, 0640), not the unit file.
