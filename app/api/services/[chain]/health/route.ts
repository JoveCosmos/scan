import { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
import { cached } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * Live health of the endpoints we publish.
 *
 * The point of the page is that these are endpoints someone can rely on, and a
 * list of URLs cannot make that case — a dead endpoint looks exactly like a
 * live one. Probing them means the page states a fact rather than an intention,
 * and shows us the same thing our users see.
 */

export interface EndpointHealth {
  url: string;
  /** False when it did not answer, answered an error, or timed out. */
  ok: boolean;
  /** Round trip in milliseconds. */
  latencyMs: number | null;
  height: number | null;
  /** True when the node is still catching up and its data is behind. */
  catchingUp: boolean | null;
  /** gRPC cannot be probed over HTTP, so it is reported rather than failed. */
  checkable: boolean;
}

async function probeRpc(url: string): Promise<Partial<EndpointHealth>> {
  const res = await fetch(`${url.replace(/\/$/, "")}/status`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(6000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(String(res.status));

  const body = (await res.json()) as {
    result?: {
      sync_info?: { latest_block_height?: string; catching_up?: boolean };
    };
  };
  const sync = body.result?.sync_info;
  const height = Number(sync?.latest_block_height);
  return {
    ok: true,
    height: Number.isFinite(height) && height > 0 ? height : null,
    catchingUp: sync?.catching_up ?? null,
  };
}

async function probeRest(url: string): Promise<Partial<EndpointHealth>> {
  const res = await fetch(
    `${url.replace(/\/$/, "")}/cosmos/base/tendermint/v1beta1/blocks/latest`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(String(res.status));

  const body = (await res.json()) as {
    block?: { header?: { height?: string } };
  };
  const height = Number(body.block?.header?.height);
  return {
    ok: true,
    height: Number.isFinite(height) && height > 0 ? height : null,
    // The REST block endpoint says nothing about sync state; absent, not false.
    catchingUp: null,
  };
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
  if (!services) {
    return NextResponse.json(
      { endpoints: [] },
      { headers: { "cache-control": "no-store" } }
    );
  }

  // Coalesced across viewers: many people on this page must not become many
  // probes against our own nodes.
  const endpoints = await cached(`svc-health:${chainId}`, 15_000, async () =>
    Promise.all(
      services.endpoints.map(async (e): Promise<EndpointHealth> => {
        const base: EndpointHealth = {
          url: e.url,
          ok: false,
          latencyMs: null,
          height: null,
          catchingUp: null,
          checkable: e.kind !== "grpc",
        };
        if (e.kind === "grpc") return base;

        const started = Date.now();
        try {
          const probed =
            e.kind === "rest" ? await probeRest(e.url) : await probeRpc(e.url);
          return { ...base, ...probed, latencyMs: Date.now() - started };
        } catch {
          // Down is a normal answer here, not an exception worth surfacing.
          return { ...base, latencyMs: Date.now() - started };
        }
      })
    )
  );

  return NextResponse.json(
    { endpoints },
    { headers: { "cache-control": "no-store" } }
  );
}
