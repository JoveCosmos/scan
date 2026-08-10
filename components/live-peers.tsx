"use client";

import { useQuery } from "@tanstack/react-query";
import type { Peer } from "@/app/api/peers/[chain]/route";
import { CopyButton } from "@/components/copy-button";

/**
 * Peers our node is connected to right now, refreshed on a timer.
 *
 * Live because the value is in being current: a peer list published once is
 * stale within the hour, and pasting a dead peer into config.toml is worse than
 * having none. Ten seconds server-side and fifteen here means many viewers
 * share one upstream request.
 */
export function LivePeers({ chainId, accent }: { chainId: string; accent: string }) {
  const { data, isPending, isError } = useQuery<{
    peers: Peer[];
    configured: boolean;
    failed?: boolean;
  }>({
    queryKey: ["peers", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/peers/${chainId}`);
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  if (!isPending && data && !data.configured) return null;

  const peers = data?.peers ?? [];
  const unavailable = isError || data?.failed;

  return (
    <div className="gata-panel" style={{ ["--panel-accent" as string]: accent }}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span
            className="gata-live-dot h-1.5 w-1.5 rounded-full"
            style={{ background: accent }}
          />
          Live peers
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {isPending ? "connecting…" : unavailable ? "unavailable" : `${peers.length} connected`}
        </span>
      </div>

      {unavailable ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Our node is not reachable at the moment. This list is read from it
          live, so it has nothing to show rather than something out of date.
        </p>
      ) : isPending ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Reading the peer list…
        </p>
      ) : peers.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          No peers connected.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border/50">
            {peers.map((peer) => (
              <li
                key={peer.address}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <code className="block truncate font-mono text-xs">
                    {peer.address}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    {peer.moniker || "unnamed"}
                    {peer.version ? ` · ${peer.version}` : ""}
                    {peer.outbound ? " · outbound" : " · inbound"}
                  </span>
                </div>
                <CopyButton value={peer.address} label="peer address" />
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            Paste into <code className="font-mono">persistent_peers</code> in
            config.toml. Refreshes every 15 seconds - these are peers our node is
            connected to right now, not a fixed list.
          </p>
        </>
      )}
    </div>
  );
}
