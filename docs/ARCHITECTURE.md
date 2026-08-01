# Architecture

A multi-chain block explorer. Next.js 15 App Router, server components for
reads, TanStack Query only for the live tickers.

Live at **https://explorer.gatahub.zone**. Deployment: [`deploy/README.md`](../deploy/README.md).

## The core idea: one UI, two chain kinds

Cosmos SDK chains and gno.land have almost nothing in common at the API level:

|                | Cosmos SDK                       | gno.land                                  |
| -------------- | -------------------------------- | ----------------------------------------- |
| Reads          | REST (LCD) `/cosmos/*`           | Tendermint2 JSON-RPC + an indexing REST API |
| Transactions   | LCD, or tx-search by event       | Indexing API (RPC has `tx_index: off`)     |
| Validators     | staking module                   | consensus set + the `valopers` realm       |
| Identity       | `description.moniker`            | realm markdown                             |
| Governance     | gov module                       | GovDAO realms — not exposed here           |
| Tx hashes      | 64 hex chars                     | base64                                     |

Rather than branch in every page, `lib/adapter.ts` exposes one `ChainAdapter`
interface. Pages call `getAdapter(chain)` and never learn which kind they have.

```
app/[chain]/*  ──►  getAdapter(chain)  ──┬──► lib/{overview,blocks,txs,validators,
                                         │      proposals,accounts}.ts   (cosmos)
                                         └──► lib/gno.ts + lib/gno-valopers.ts (gno)
                                                        │
                                              lib/lcd.ts fetchFrom()
```

### Capabilities, not chain-name checks

The adapter publishes what a chain can actually do, so the UI hides what would
otherwise render as a misleading zero:

- `staking` — gno has no staking module, so the validator table drops the
  Staked and Commission columns.
- `slashingWindow` — gno has no slashing module, so its uptime percentage is
  measured over recent blocks only and the tooltip says so.
- `stakeWeighted` — gno voting power is *assigned*, so the Nakamoto coefficient
  is labelled "of voting power" rather than "of stake".
- `registry` — gno has a validator registry (96) larger than its active set (87).
- `governance` — gno gets no Proposals tab, and `/topaz-1/proposals` 404s.

Adding a chain without governance needs no code change, only config.

## Adding a chain

Drop a JSON file in `config/chains/`. It is validated by zod at load
(`lib/chains.ts`); a bad file fails loudly at startup rather than at request time.

```jsonc
{
  "chainId": "provider",            // also the URL segment
  "prettyName": "Cosmos Hub Testnet",
  "kind": "cosmos",                 // "cosmos" | "gno"
  "network": "testnet",             // groups the switcher and landing page
  "bech32Prefix": "cosmos",         // drives address search
  "denom": "uatom",
  "exponent": 6,
  "lcdEndpoints": ["…"],            // required when kind=cosmos
  "rpcEndpoints": ["…"],
  "apiEndpoints": ["…"],            // required when kind=gno
  "accent": "#36D399"               // must be unique across chains
}
```

## Addresses are all the same key

A bech32 address is a prefix plus a 20-byte payload, so several things that look
like lookups are pure local re-encodings:

| From | To | Used for |
| --- | --- | --- |
| `cosmos1…` | `akash1…`, `atone1…`, `g1…` | the cross-chain address switcher |
| `cosmosvaloper1…` | `cosmos1…` | a validator's self-delegation account |
| ed25519 pubkey | `cosmosvalcons1…` + base64 | matching slashing records and block signatures |

That last one is not bech32 — a consensus address is the first 20 bytes of
`sha256(pubkey)`, which blocks carry base64-encoded and the slashing module
keys bech32-encoded. One derivation feeds both.

The switcher deliberately **refuses operator addresses**: re-encoding one yields
a valid-looking address that is not the same entity. `accountFromOperator` is
the opposite direction and is explicitly allowed, because that account *is* the
validator.

This makes the navigation loop close: validator → its account → the same account
on other chains → that chain's validator, all without a network call.

## Performance

Three deliberate mechanisms, each solving a measured problem:

**Request coalescing** (`lib/cache.ts`). Every viewer polls independently, so N
tabs meant N upstream requests per interval. A short TTL with in-flight
de-duplication collapses concurrent viewers into one upstream request. Measured:
warm `txs` 2.43s → 0.0095s. TTLs are shorter than the client poll intervals, so
head-of-chain data still advances.

**Endpoint health** (`lib/lcd.ts`). `fetchFrom` remembers which endpoint last
answered and tries it first. Without this a dead primary cost the full 5s
timeout on every request before failing over.

**The valopers index** (`lib/gno-valopers.ts`). gno validator identity requires
~96 `vm/qrender` calls, which the node serialises — measured 95-way parallel at
14.6s versus 15.9s at 20-way, so concurrency does not help. It is therefore
built once, cached to disk (`VALOPER_CACHE_DIR`, outside the release tree so a
deploy never discards it), warmed at boot by `instrumentation.ts`, and refreshed
stale-while-revalidate.

## Things that are not bugs

Hard-won, and each one cost time to find:

- **`next build` rewrites `.next` under a running server.** Deploys build into a
  new release directory and swap a symlink. Never build in the live directory.
- **`HOSTNAME=127.0.0.1` does not restrict `next start`** — it still binds
  `0.0.0.0`. Only `--hostname` on the command line does.
- **Next hands route params through percent-encoded.** gno's base64 tx hashes
  break without `decodeParam` at the boundary.
- **A `loading.tsx` at a route segment makes 404s return HTTP 200**, because the
  shell streams before the page body runs. Suspense *inside* the page keeps both
  the skeleton and the status code.
- **Gov modules delete votes on tally**, so a finished proposal has none in
  state. The votes list falls back to reconstructing them from `MsgVote`
  transactions and says so.
- **Tx search reports its count in a top-level `total`**, not under
  `pagination`, and caps pages at 100 regardless of the requested limit.
- **`Buffer.from(x, "base64")` is lenient** — it drops invalid characters
  instead of throwing, so junk still yields bytes, which hash to a valid-looking
  consensus address that matches nothing. Consensus keys are checked for exactly
  32 bytes.
- **AtomOne's gov module has no `NoWithVeto`.** `Tally.veto` is nullable and the
  bar omits that segment rather than drawing a permanent zero.

## Testing

`npm test` — 69 vitest tests over the pure logic. `npm run build` runs
`tsc --noEmit && vitest run` first, so a type error or a failing test stops a
deploy before the symlink swaps.

Deliberately not covered: anything requiring a live chain. Those paths are
verified against real endpoints by hand, because mocking them would only assert
that the mocks match yesterday's API.

## Security

The app holds no secrets — every endpoint is a public node URL, and there are no
build-time env vars. It runs as a dedicated `explorer` user that cannot read
gata-hub's data, bound to loopback behind nginx. See
[`deploy/README.md`](../deploy/README.md).

Validator- and proposer-authored content (valoper profiles, proposal summaries)
is rendered as **plain text, never HTML**.
