import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
import { cached } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * Peers our own node is currently connected to.
 *
 * Read from that node's `/net_info`, which is why the source URL lives in
 * services.json and is never rendered: it may not be publicly reachable, and it
 * is the source for this list rather than something we advertise.
 */

interface NetInfoPeer {
  node_info?: {
    id?: string;
    moniker?: string;
    version?: string;
    listen_addr?: string;
    network?: string;
  };
  remote_ip?: string;
  is_outbound?: boolean;
}

export interface Peer {
  /** `nodeId@host:port`, ready to paste into config.toml. */
  address: string;
  moniker: string;
  version: string;
  outbound: boolean;
}

/**
 * A peer's own listen_addr is usually `tcp://0.0.0.0:26656` — the port is real,
 * the host is not. Combining it with the address we actually reached them on
 * gives something dialable.
 */
function peerAddress(peer: NetInfoPeer): string | null {
  const id = peer.node_info?.id;
  const ip = peer.remote_ip;
  if (!id || !ip) return null;

  const port = peer.node_info?.listen_addr?.match(/:(\d+)$/)?.[1] ?? "26656";
  // Bracket IPv6, which is otherwise ambiguous against the port separator.
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return `${id}@${host}:${port}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chain: string }> }
) {
  const { chain: chainId } = await params;

  if (!getChain(chainId)) {
    return NextResponse.json({ error: `Unknown chain "${chainId}"` }, { status: 404 });
  }

  const services = servicesFor(chainId);
  if (!services?.netInfoRpc) {
    // Not an error: a chain we do not run a node for simply has no peer list.
    return NextResponse.json(
      { peers: [], configured: false },
      { headers: { "cache-control": "no-store" } }
    );
  }

  try {
    // Coalesced so a page open in many tabs still makes one request upstream.
    const peers = await cached(`peers:${chainId}`, 10_000, async () => {
      const res = await fetch(
        `${services.netInfoRpc!.replace(/\/$/, "")}/net_info`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(8000),
          cache: "no-store",
        }
      );
      if (!res.ok) throw new Error(`net_info responded ${res.status}`);

      const body = (await res.json()) as { result?: { peers?: NetInfoPeer[] } };
      const out: Peer[] = [];
      for (const p of body.result?.peers ?? []) {
        const address = peerAddress(p);
        if (!address) continue;
        out.push({
          address,
          moniker: p.node_info?.moniker ?? "",
          version: p.node_info?.version ?? "",
          outbound: p.is_outbound === true,
        });
      }
      return out;
    });

    return NextResponse.json(
      { peers, configured: true, count: peers.length },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    // The node being down must not take the page down with it.
    return NextResponse.json(
      { peers: [], configured: true, failed: true },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
