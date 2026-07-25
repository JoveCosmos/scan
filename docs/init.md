Build a multi-chain Cosmos block explorer in Next.js 15 App Router + TS + Tailwind + shadcn/ui.



Structure:

\- config/chains/\*.json registry (chainId, name, prettyName, logo, bech32Prefix,

&#x20; denom, exponent, lcdEndpoints\[], rpcEndpoints\[], wsEndpoint, featuredValidator)

\- lib/chains.ts loads + validates registry with zod

\- lib/lcd.ts: fetch wrapper with endpoint failover, timeout, retry, typed responses

\- app/\[chain]/... routes: overview, blocks, blocks/\[height], txs, txs/\[hash],

&#x20; validators, validators/\[addr], accounts/\[addr], proposals, proposals/\[id]

\- Server components for data fetching with revalidate tags; TanStack Query

&#x20; only for live block ticker



Start with: registry + lcd client + app/\[chain]/page.tsx overview showing

latest block, block time, active validator count, bonded ratio. Seed configs

for cosmoshub-4, atomone-1, akashnet-2. Then stop and let me review before

building remaining routes

