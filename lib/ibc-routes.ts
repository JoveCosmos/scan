import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getChain, type ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";
import { cached } from "@/lib/cache";

/**
 * The IBC routes we watch, and whether each one is actually working.
 *
 * A list of channels is not useful on its own - chains accumulate dead
 * channels, and a channel in state OPEN can still be unusable. Two things
 * decide whether a route carries traffic today, and neither is visible from a
 * channel listing:
 *
 *   Light client status. Each side tracks the other with a light client that
 *   must be refreshed inside its trusting period. Miss that window and the
 *   client expires - the channel stays OPEN and nothing can pass through it
 *   until somebody performs a client recovery. This is the single most useful
 *   thing to show, and it is why AtomOne's channel-0 to Osmosis is a museum
 *   piece while channel-2 is the live path.
 *
 *   Pending packet commitments. A packet sent but not yet received leaves a
 *   commitment behind. A handful is normal traffic in flight; a growing pile
 *   means no relayer is clearing them.
 */

const sideSchema = z.object({
  chainId: z.string().min(1),
  channelId: z.string().min(1),
  portId: z.string().min(1).default("transfer"),
  clientId: z.string().min(1),
  connectionId: z.string().min(1),
});

const routesSchema = z.object({
  routes: z
    .array(z.object({ a: sideSchema, b: sideSchema }))
    .default([]),
});

export type RouteSide = z.infer<typeof sideSchema>;

/** Health of one end of a route. Nulls mean "could not ask", never "zero". */
export interface SideHealth extends RouteSide {
  prettyName: string;
  accent: string;
  /** Active | Expired | Frozen | Unknown, straight from the client module. */
  clientStatus: string | null;
  channelState: string | null;
  /** Packets sent from this side and not yet received by the other. */
  pendingPackets: number | null;
}

export interface RouteHealth {
  a: SideHealth;
  b: SideHealth;
}

let cache: { routes: { a: RouteSide; b: RouteSide }[] } | null = null;

function load(): { a: RouteSide; b: RouteSide }[] {
  if (cache) return cache.routes;

  const file = path.join(process.cwd(), "config", "ibc-routes.json");
  if (!fs.existsSync(file)) {
    cache = { routes: [] };
    return cache.routes;
  }

  const parsed = routesSchema.safeParse(
    JSON.parse(fs.readFileSync(file, "utf8"))
  );
  if (!parsed.success) {
    console.error("config/ibc-routes.json is invalid:", parsed.error.message);
    cache = { routes: [] };
    return cache.routes;
  }

  cache = { routes: parsed.data.routes };
  return cache.routes;
}

/** Routes with at least one end on the given chain. */
function routesFor(chainId: string): { a: RouteSide; b: RouteSide }[] {
  return load()
    .filter((r) => r.a.chainId === chainId || r.b.chainId === chainId)
    // Always render the chain being viewed on the left, so the table reads
    // outward from where you are rather than in registry order.
    .map((r) => (r.a.chainId === chainId ? r : { a: r.b, b: r.a }));
}

async function sideHealth(side: RouteSide): Promise<SideHealth> {
  const chain = getChain(side.chainId);
  const base: SideHealth = {
    ...side,
    prettyName: chain?.prettyName ?? side.chainId,
    accent: chain?.accent ?? "#3B9EFF",
    clientStatus: null,
    channelState: null,
    pendingPackets: null,
  };
  if (!chain) return base;

  const [clientStatus, channelState, pendingPackets] = await Promise.all([
    clientStatusOf(chain, side.clientId),
    channelStateOf(chain, side),
    pendingOf(chain, side),
  ]);

  return { ...base, clientStatus, channelState, pendingPackets };
}

async function clientStatusOf(
  chain: ChainConfig,
  clientId: string
): Promise<string | null> {
  return cached(`ibc:cstatus:${chain.chainId}:${clientId}`, 120_000, async () => {
    const res: { status?: string } = await fetchLcd(
      chain,
      `/ibc/core/client/v1/client_status/${clientId}`,
      { timeoutMs: 10_000 }
    );
    return res.status ?? null;
  }).catch(() => null);
}

async function channelStateOf(
  chain: ChainConfig,
  side: RouteSide
): Promise<string | null> {
  return cached(
    `ibc:chstate:${chain.chainId}:${side.portId}:${side.channelId}`,
    600_000,
    async () => {
      const res: { channel?: { state?: string } } = await fetchLcd(
        chain,
        `/ibc/core/channel/v1/channels/${side.channelId}/ports/${side.portId}`,
        { timeoutMs: 10_000 }
      );
      return (res.channel?.state ?? "").replace(/^STATE_/, "").toLowerCase() || null;
    }
  ).catch(() => null);
}

async function pendingOf(
  chain: ChainConfig,
  side: RouteSide
): Promise<number | null> {
  return cached(
    `ibc:pending:${chain.chainId}:${side.portId}:${side.channelId}`,
    60_000,
    async () => {
      // pagination.total is the whole point of this call; one row is enough to
      // get it, and asking for more would page through thousands on a busy
      // channel for a number the response already carries.
      const res: { pagination?: { total?: string } } = await fetchLcd(
        chain,
        `/ibc/core/channel/v1/channels/${side.channelId}/ports/${side.portId}/packet_commitments`,
        {
          timeoutMs: 12_000,
          searchParams: { "pagination.limit": 1, "pagination.count_total": true },
        }
      );
      const n = Number(res.pagination?.total);
      return Number.isFinite(n) ? n : null;
    }
  ).catch(() => null);
}

/** Both ends of every route touching this chain, probed in parallel. */
export async function routeHealth(chainId: string): Promise<RouteHealth[]> {
  const routes = routesFor(chainId);
  return Promise.all(
    routes.map(async (r) => ({
      a: await sideHealth(r.a),
      b: await sideHealth(r.b),
    }))
  );
}

/**
 * Whether a route can carry a packet right now.
 *
 * Both clients must be Active: a channel is only as alive as the light client
 * the *other* side keeps of it, so one expired client stops traffic in both
 * directions even though both channels still read OPEN.
 */
export function routeIsLive(route: RouteHealth): boolean {
  return (
    route.a.clientStatus === "Active" &&
    route.b.clientStatus === "Active" &&
    route.a.channelState === "open" &&
    route.b.channelState === "open"
  );
}
