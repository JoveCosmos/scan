import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const chainConfigSchema = z.object({
  chainId: z.string().min(1),
  name: z.string().min(1),
  prettyName: z.string().min(1),
  logo: z.string(),
  bech32Prefix: z.string().min(1),
  denom: z.string().min(1),
  exponent: z.number().int().nonnegative(),
  lcdEndpoints: z.array(z.string().url()).min(1),
  rpcEndpoints: z.array(z.string().url()).min(1),
  wsEndpoint: z.string().min(1),
  featuredValidator: z.string().nullable(),
  /** Per-chain accent, drawn from the GATA ramp. Falls back to brand blue. */
  accent: z.string().optional(),
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
