import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The infrastructure GATA HUB runs and offers publicly.
 *
 * Deliberately separate from `config/chains/*.json`. Those describe a *chain* —
 * its denom, its prefix, endpoints the explorer reads from. This describes what
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
  /** Shown under the URL — rate limits, retention, anything a user needs. */
  note: z.string().optional(),
});

const chainServicesSchema = z.object({
  /** Must match a chainId in config/chains, so the page can show its accent. */
  chainId: z.string().min(1),
  endpoints: z.array(endpointSchema).default([]),
  /**
   * Persistent peer or seed strings, copied as-is into a node's config.toml.
   * Format is `nodeId@host:port`.
   */
  peers: z.array(z.string().min(1)).default([]),
  seeds: z.array(z.string().min(1)).default([]),
  snapshot: z
    .object({
      url: z.string().url(),
      /** How often it is taken, in words. "Daily at 02:00 UTC". */
      schedule: z.string().optional(),
      /** Pruning settings the snapshot was taken with. */
      pruning: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  /** Installation or joining guide — ours, or the chain's if we have none. */
  guide: z.string().url().optional(),
  /**
   * Our own node's RPC, read server-side to list live peers. NOT rendered:
   * it is the source for the peer list, not something we advertise, and it may
   * be an address that is not publicly reachable at all.
   */
  netInfoRpc: z.string().url().optional(),
});

const servicesSchema = z.object({
  website: z.string().url().optional(),
  git: z.string().url().optional(),
  contact: z.string().optional(),
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
  const s = getServices();
  return s.chains.some(
    (c) =>
      c.endpoints.length > 0 ||
      c.peers.length > 0 ||
      c.seeds.length > 0 ||
      c.snapshot !== undefined
  );
}
