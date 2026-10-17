import type { ChainConfig } from "@/lib/chains";
import { freshEndpoints } from "@/lib/endpoint-health";

export type AbciResult = { ok: true; data: string } | { ok: false; missing: boolean };

/**
 * One abci_query against a gno.land node: auth/accounts/…, vm/qrender,
 * vm/qfile, vm/qeval and the rest. `missing` tells "the node answered with an
 * error" (no such package or account) from "no node answered", so a page can
 * 404 only on the first. Each configured endpoint is tried in turn, the
 * fallbacks last.
 */
export async function abciQuery(
  chain: ChainConfig,
  path: string,
  data = "",
  timeoutMs = 8000
): Promise<AbciResult> {
  const rpc = await freshEndpoints("rpc", chain.rpcEndpoints, chain.fallbackRpcEndpoints);
  for (const endpoint of [...rpc.primaries, ...rpc.fallbacks]) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "abci_query",
          params: { path, data: Buffer.from(data).toString("base64") },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        error?: unknown;
        result?: { response?: { ResponseBase?: { Data?: string | null; Error?: unknown } } };
      };
      if (json.error) continue;
      const base = json.result?.response?.ResponseBase;
      if (!base) continue;
      if (base.Error) return { ok: false, missing: true };
      return { ok: true, data: Buffer.from(base.Data ?? "", "base64").toString() };
    } catch {
      continue;
    }
  }
  return { ok: false, missing: false };
}
