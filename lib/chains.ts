import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const chainConfigSchema = z
  .object({
    chainId: z.string().min(1),
    name: z.string().min(1),
    prettyName: z.string().min(1),
    logo: z.string(),
    bech32Prefix: z.string().min(1),
    denom: z.string().min(1),
    exponent: z.number().int().nonnegative(),
    /**
     * "cosmos" chains are read over the Cosmos SDK REST (LCD) API. "gno" chains
     * expose no /cosmos/* modules at all — they are read over Tendermint2 JSON-RPC
     * plus an indexing REST API, so they need a different adapter entirely.
     */
    kind: z.enum(["cosmos", "gno"]).default("cosmos"),
    /** Groups chains in the switcher and on the landing page. */
    network: z.enum(["mainnet", "testnet"]).default("mainnet"),
    /**
     * CoinGecko id, for price and market cap. Absent on testnets and on chains
     * with no traded token, which simply show no market figures.
     */
    coingeckoId: z.string().optional(),
    /** Project homepage, shown on the Params tab. */
    website: z.string().url().optional(),
    /** Source repository, shown on the Params tab. */
    repo: z.string().url().optional(),
    lcdEndpoints: z.array(z.string().url()).default([]),
    rpcEndpoints: z.array(z.string().url()).min(1),
    /** Indexing REST API. Required for gno, where the RPC cannot list txs. */
    apiEndpoints: z.array(z.string().url()).default([]),
    /** Optional GraphQL tx-indexer, used to enrich single-tx lookups. */
    indexerEndpoints: z.array(z.string().url()).default([]),
    wsEndpoint: z.string().min(1),
    featuredValidator: z.string().nullable(),
    /** Per-chain accent, drawn from the GATA ramp. Falls back to brand blue. */
    accent: z.string().optional(),
  })
  .superRefine((chain, ctx) => {
    if (chain.kind === "cosmos" && chain.lcdEndpoints.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `chain "${chain.chainId}" is kind "cosmos" and needs at least one lcdEndpoint`,
      });
    }
    if (chain.kind === "gno" && chain.apiEndpoints.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `chain "${chain.chainId}" is kind "gno" and needs at least one apiEndpoint (the RPC cannot list transactions)`,
      });
    }
  });

export type ChainConfig = z.infer<typeof chainConfigSchema>;

const CHAINS_DIR = path.join(process.cwd(), "config", "chains");

let cachedChains: ChainConfig[] | null = null;

function loadChains(): ChainConfig[] {
  if (cachedChains) return cachedChains;

  const files = fs.readdirSync(CHAINS_DIR).filter((f) => f.endsWith(".json"));

  const chains = files.map((file) => {
    const raw = fs.readFileSync(path.join(CHAINS_DIR, file), "utf-8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in config/chains/${file}: ${(err as Error).message}`);
    }
    const result = chainConfigSchema.safeParse(json);
    if (!result.success) {
      throw new Error(`Invalid chain config in config/chains/${file}: ${result.error.message}`);
    }
    return result.data;
  });

  const seen = new Set<string>();
  for (const chain of chains) {
    if (seen.has(chain.chainId)) {
      throw new Error(`Duplicate chainId "${chain.chainId}" in config/chains`);
    }
    seen.add(chain.chainId);
  }

  cachedChains = chains;
  return chains;
}

export function getAllChains(): ChainConfig[] {
  return loadChains();
}

export function getChain(chainId: string): ChainConfig | undefined {
  return loadChains().find((c) => c.chainId === chainId);
}

export const GATA_BLUE = "#3B9EFF";

export function accentFor(chain: ChainConfig): string {
  return chain.accent ?? GATA_BLUE;
}

/** Display ticker derived from the base denom: "uatom" -> "ATOM". */
export function symbolFor(chain: ChainConfig): string {
  return chain.denom.replace(/^u/, "").toUpperCase();
}
