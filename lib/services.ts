import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The infrastructure GATA HUB runs and offers publicly.
 *
 * Deliberately separate from `config/chains/*.json`. Those describe a *chain* —
 * its denom, its prefix, endpoints Scan reads from. This describes what
 * we operate, which is a different thing entirely and changes for different
 * reasons.
 *
 * Every field is optional and anything absent is simply not rendered. That is
 * the point: an endpoint we do not run must never appear as one we do, and a
 * half-filled config should produce a shorter page rather than a page full of
 * dead links.
 */

const endpointSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  /**
   * What it speaks, which decides how health is checked. gRPC is not reachable
   * over plain HTTP, so it is listed but never probed — better than showing a
   * permanent red mark against a service that is fine.
   */
  kind: z.enum(["rpc", "rest", "grpc"]).default("rpc"),
  /** Shown under the URL — rate limits, retention, anything a user needs. */
  note: z.string().optional(),
});

const chainServicesSchema = z.object({
  /**
   * Must match a chainId in config/chains. The chain's own website and source
   * repository come from there rather than being repeated here — those belong
   * to the project, not to us.
   */
  chainId: z.string().min(1),
  /**
   * What we run for this chain. "full" keeps history and can serve a snapshot;
   * "pruned" validates and answers current state but forgets. Declared rather
   * than detected, because a node's pruning settings are not visible over its
   * API — earliest_block_height moves as it prunes, which cannot distinguish a
   * pruned node from a full one that started late.
   */
  nodeType: z.enum(["full", "pruned"]).default("pruned"),
  endpoints: z.array(endpointSchema).default([]),
  /**
   * The node binary and its home directory, used to generate restore commands
   * someone can paste. Without them the snapshot panel shows details only —
   * a half-right command that deletes a data directory is worse than none.
   */
  daemon: z.string().optional(),
  home: z.string().optional(),
  snapshot: z
    .object({
      url: z.string().url(),
      /**
       * "live" once the file at `url` actually exists. Anything else renders
       * the panel as a preview and does not offer the download: publishing a
       * link to a snapshot we have not taken yet sends people to a 404 after
       * they have already stopped their node.
       */
      status: z.enum(["live", "planned"]).default("planned"),
      /** How often it is taken, in words. "Daily at 02:00 UTC". */
      schedule: z.string().optional(),
      /** Pruning settings the snapshot was taken with. */
      pruning: z.string().optional(),
      /** Compressed size, in words. "42 GB". */
      size: z.string().optional(),
      /** Height the snapshot was taken at. */
      height: z.number().optional(),
      /** ISO timestamp of the most recent snapshot. */
      takenAt: z.string().optional(),
      /** Node version the snapshot is compatible with. */
      version: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  /** Installation or joining guide — ours, or the chain's if we have none. */
  guide: z.string().url().optional(),
});

const servicesSchema = z.object({
  chains: z.array(chainServicesSchema).default([]),
});

export type Endpoint = z.infer<typeof endpointSchema>;
export type ChainServices = z.infer<typeof chainServicesSchema>;
export type Services = z.infer<typeof servicesSchema>;

let cache: Services | null = null;

export function getServices(): Services {
  if (cache) return cache;

  const file = path.join(process.cwd(), "config", "services.json");
  if (!fs.existsSync(file)) {
    cache = { chains: [] };
    return cache;
  }

  const parsed = servicesSchema.safeParse(
    JSON.parse(fs.readFileSync(file, "utf8"))
  );
  if (!parsed.success) {
    // Loud, because a typo here silently removes a service from the page rather
    // than breaking anything visible.
    console.error("config/services.json is invalid:", parsed.error.message);
    cache = { chains: [] };
    return cache;
  }

  cache = parsed.data;
  return cache;
}

export function servicesFor(chainId: string): ChainServices | null {
  return getServices().chains.find((c) => c.chainId === chainId) ?? null;
}

/** Whether there is anything at all worth showing a link to. */
export function hasServices(): boolean {
  return getServices().chains.some(hasAnything);
}

/** Whether this one chain has anything, which decides if its tab appears. */
export function hasServicesFor(chainId: string): boolean {
  const c = servicesFor(chainId);
  return c !== null && hasAnything(c);
}

/** Chains we publish something for, in config order. */
export function servedChainIds(): string[] {
  return getServices()
    .chains.filter(hasAnything)
    .map((c) => c.chainId);
}

function hasAnything(c: ChainServices): boolean {
  return c.endpoints.length > 0 || c.snapshot !== undefined || c.guide !== undefined;
}

/**
 * Networks grouped by the kind of node we run, in config order.
 *
 * Every chain we operate appears, whether or not we publish endpoints for it —
 * "we run a pruned node here" is worth saying on its own, and is why a chain
 * can sit in services.json with nothing else filled in.
 */
export function chainsByNodeType(): {
  full: ChainServices[];
  pruned: ChainServices[];
} {
  const chains = getServices().chains;
  return {
    full: chains.filter((c) => c.nodeType === "full"),
    pruned: chains.filter((c) => c.nodeType === "pruned"),
  };
}
