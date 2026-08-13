import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DenomInfo } from "@/lib/coin";

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
     * Fee token, when it is not the staking token. AtomOne pays fees in PHOTON
     * (uphoton) while staking and governance use ATONE, so a fee shown with the
     * ATONE symbol is simply wrong. Same exponent as `denom` unless a chain
     * ever needs otherwise.
     */
    feeDenom: z.string().optional(),
    /** CoinGecko id for the fee token, when it is separately traded. */
    feeCoingeckoId: z.string().optional(),
    /** Hard cap on the fee token's supply, in whole tokens. PHOTON is capped
     *  at 1 billion; ATONE has no cap. */
    feeSupplyCap: z.number().optional(),
    /**
     * "cosmos" chains are read over the Cosmos SDK REST (LCD) API. "gno" chains
     * expose no /cosmos/* modules at all — they are read over Tendermint2 JSON-RPC
     * plus an indexing REST API, so they need a different adapter entirely.
     */
    kind: z.enum(["cosmos", "gno"]).default("cosmos"),
    /**
     * Kept for context where a chain is named without its network being
     * obvious — the search disambiguation list, mainly. It no longer groups the
     * switcher: mainnets and testnets are listed together in `order`, because
     * splitting them buried AtomOne's testnet far from AtomOne itself when the
     * two are worked on side by side.
     */
    network: z.enum(["mainnet", "testnet"]).default("mainnet"),
    /**
     * Position in the switcher and anywhere else chains are listed. Ascending,
     * and deliberately not derived from name or network — the intended reading
     * order is "ours first, then the rest", which no property of the chain
     * itself expresses. A chain without one sorts to the end by prettyName, so
     * adding a chain stays a JSON file and never a renumbering exercise.
     */
    order: z.number().int().optional(),
    /**
     * How much of this chain we undertake to serve — see lib/tiers.ts. Policy,
     * not capability: "limited" means we chose not to carry a section, where a
     * missing capability means the chain has no such module.
     *
     * Defaults to "medium" so a chain added without one gets a working page
     * rather than silently losing its transactions.
     */
    tier: z.enum(["high", "medium", "limited"]).default("medium"),
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
    /**
     * Our own nodes, tried only when every endpoint above has failed.
     *
     * Separate from the lists above rather than appended to them because the
     * fetch layer promotes whichever endpoint last answered — one failover
     * would otherwise leave the scan reading from our validator indefinitely.
     * These are for building against and for keeping the site up, not for
     * carrying its traffic.
     */
    fallbackLcdEndpoints: z.array(z.string().url()).default([]),
    fallbackRpcEndpoints: z.array(z.string().url()).default([]),
    /** Indexing REST API. Required for gno, where the RPC cannot list txs. */
    apiEndpoints: z.array(z.string().url()).default([]),
    /** Optional GraphQL tx-indexer, used to enrich single-tx lookups. */
    indexerEndpoints: z.array(z.string().url()).default([]),
    /**
     * Optional, and currently read by nothing — live data is polled over HTTP.
     * Required until a chain came along with no public websocket to point at,
     * which would have meant inventing a URL to satisfy a field no code uses.
     */
    wsEndpoint: z.string().min(1).optional(),
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

  // Sorted once here so every list — switcher, landing page, search results —
  // agrees. Order was previously whatever readdir returned, which is
  // alphabetical on this filesystem but is not guaranteed to be anywhere.
  chains.sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || a.prettyName.localeCompare(b.prettyName);
  });

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

/** Display ticker derived from a base denom: "uatom" -> "ATOM". */
export function symbolForDenom(denom: string): string {
  return denom.replace(/^u/, "").toUpperCase();
}

/** Display ticker for the staking token. */
export function symbolFor(chain: ChainConfig): string {
  return symbolForDenom(chain.denom);
}

/** The staking token, and the fee token when it differs. */
export function chainDenoms(chain: ChainConfig): DenomInfo[] {
  const out: DenomInfo[] = [
    { denom: chain.denom, symbol: symbolFor(chain), exponent: chain.exponent },
  ];
  if (chain.feeDenom && chain.feeDenom !== chain.denom) {
    out.push({
      denom: chain.feeDenom,
      symbol: symbolForDenom(chain.feeDenom),
      exponent: chain.exponent,
    });
  }
  return out;
}
