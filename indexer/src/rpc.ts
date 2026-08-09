import type { BlockResponse, BlockResultsResponse } from "./extract";

/**
 * Minimal CometBFT RPC client.
 *
 * Deliberately small: the worker needs three calls, and the explorer's own
 * `lib/lcd.ts` is for the REST API, not this one.
 */

export class RpcError extends Error {}

async function get<T>(base: string, path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new RpcError(`${path} responded ${res.status}`);
  return (await res.json()) as T;
}

export interface StatusResponse {
  result?: {
    sync_info?: {
      latest_block_height?: string;
      earliest_block_height?: string;
      catching_up?: boolean;
    };
  };
}

export class Rpc {
  constructor(
    private readonly base: string,
    private readonly timeoutMs = 15_000
  ) {}

  status() {
    return get<StatusResponse>(this.base, "/status", this.timeoutMs);
  }

  /** Current committed head. Never index above this. */
  async head(): Promise<number> {
    const s = await this.status();
    const h = Number(s.result?.sync_info?.latest_block_height);
    if (!Number.isFinite(h) || h <= 0) throw new RpcError("no latest height");
    return h;
  }

  /** Oldest height this node still serves — the backfill floor. */
  async earliest(): Promise<number | null> {
    const s = await this.status();
    const h = Number(s.result?.sync_info?.earliest_block_height);
    return Number.isFinite(h) && h > 0 ? h : null;
  }

  block(height: number) {
    return get<BlockResponse>(this.base, `/block?height=${height}`, this.timeoutMs);
  }

  blockResults(height: number) {
    return get<BlockResultsResponse>(
      this.base,
      `/block_results?height=${height}`,
      this.timeoutMs
    );
  }
}
