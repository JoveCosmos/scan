# GATA SCAN

Multi-chain block scan, live at **https://explorer.gatahub.zone**.

Blocks, transactions, validators, governance and accounts across six networks,
read straight from full nodes with no indexer of our own.

| Network | Chain              | ID                  |
| ------- | ------------------ | ------------------- |
| Mainnet | Cosmos Hub         | `cosmoshub-4`       |
| Mainnet | AtomOne            | `atomone-1`         |
| Mainnet | Akash              | `akashnet-2`        |
| Testnet | Cosmos Hub Testnet | `provider`          |
| Testnet | AtomOne Testnet    | `atomone-testnet-1` |
| Testnet | Gno.land Testnet   | `sapphire-1`        |

## Develop

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # unit tests
npm run build        # runs tsc --noEmit && vitest run first
```

No environment variables are needed — every endpoint lives in
`config/chains/*.json`. Adding a chain is a JSON file, not code; see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Deploy

`git push` to `master`. A timer on the server picks it up within 5 minutes,
builds into a new release directory, swaps a symlink atomically, health-checks,
and rolls back automatically if the new release does not answer.

Server setup and runbook: [`deploy/README.md`](deploy/README.md).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how one UI serves two
  incompatible chain kinds, how to add a chain, the performance mechanisms, and
  the non-obvious platform behaviours that cost time to discover.
- [`deploy/README.md`](deploy/README.md) — server layout, isolation, operations.

## Stack

Next.js 15 (App Router), React 19, TypeScript, Tailwind v4, TanStack Query for
the live tickers only, vitest.
