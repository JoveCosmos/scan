import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The infrastructure GATA HUB runs and offers publicly.
 *
 * Deliberately separate from `config/chains/*.json`. Those describe a *chain* -
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
   * over plain HTTP, so it is listed but never probed - better than showing a
   * permanent red mark against a service that is fine.
   */
  kind: z.enum(["rpc", "rest", "grpc"]).default("rpc"),
  /** Shown under the URL - rate limits, retention, anything a user needs. */
  note: z.string().optional(),
});

const chainServicesSchema = z.object({
  /**
   * Must match a chainId in config/chains. The chain's own website and source
   * repository come from there rather than being repeated here - those belong
   * to the project, not to us.
   */
  chainId: z.string().min(1),
  endpoints: z.array(endpointSchema).default([]),
  /**
   * Only the parts of state sync that are a choice. The RPC servers come from
   * the endpoints above and the trust height and hash are computed live, since
   * a hash written into a config file is wrong within days.
   */
  stateSync: z
    .object({
      /** Must be shorter than the chain's unbonding period. */
      trustPeriod: z.string().optional(),
      /** True only where our node keeps the snapshot interval a sync needs
       *  (app.toml snapshot-interval > 0). Off by default: none does today. */
      enabled: z.boolean().default(false),
    })
    .optional(),
  /**
   * Key for this chain in the published snapshot manifest. Everything that
   * changes nightly - height, size, filename, checksum - is read from there at
   * render time rather than committed here, where it goes stale in a day.
   */
  snapshotKey: z.string().optional(),
  snapshot: z
    .object({
      /**
       * Only for a chain we have not started publishing. Once `snapshotKey`
       * resolves in the manifest, the live URL wins over anything written here.
       */
      url: z.string().url().optional(),
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
    })
    .optional(),
});

const servicesSchema = z.object({
  chains: z.array(chainServicesSchema).default([]),
});

export type Endpoint = z.infer<typeof endpointSchema>;
export type ChainServices = z.infer<typeof chainServicesSchema>;
export type Services = z.infer<typeof servicesSchema>;

let cache: Services | null = null;

function getServices(): Services {
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
