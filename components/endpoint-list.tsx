"use client";

import { useQuery } from "@tanstack/react-query";
import type { EndpointHealth } from "@/app/api/services/[chain]/health/route";
import type { Endpoint } from "@/lib/services";
import { CopyButton } from "@/components/copy-button";

/**
 * The endpoints we publish, with whether they are actually answering.
 *
 * Health is client-side and polled rather than rendered once on the server: a
 * status baked into a cached page is a claim about the past, and the whole
 * reason to show it is that it is true now.
 */
export function EndpointList({
  chainId,
  endpoints,
  accent,
}: {
  chainId: string;
  endpoints: Endpoint[];
  accent: string;
}) {
  const { data } = useQuery<{ endpoints: EndpointHealth[] }>({
    queryKey: ["svc-health", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/services/${chainId}/health`);
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const health = new Map((data?.endpoints ?? []).map((h) => [h.url, h]));

  return (
    <div className="gata-panel" style={{ ["--panel-accent" as string]: accent }}>
      <h3 className="border-b border-border px-4 py-3 text-sm font-medium">
        Endpoints
      </h3>
      <ul className="divide-y divide-border/50">
        {endpoints.map((e) => (
          <li key={e.url} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{e.label}</span>
                  <Status health={health.get(e.url)} />
                </div>
                <code className="mt-0.5 block truncate font-mono text-sm">
                  {e.url}
                </code>
                {e.note ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {e.note}
                  </div>
                ) : null}
              </div>
              <CopyButton value={e.url} label={`${e.label} endpoint`} />
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        Checked every 30 seconds from this page.
      </p>
    </div>
  );
}

function Status({ health }: { health: EndpointHealth | undefined }) {
  if (!health) {
    return <span className="text-xs text-muted-foreground">checking…</span>;
  }

  if (!health.checkable) {
    // Saying nothing is better than a red mark against a service that is fine.
    return (
      <span className="text-xs text-muted-foreground" title="gRPC cannot be checked over HTTP">
        not checked
      </span>
    );
  }

  if (!health.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--gata-burn)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--gata-burn)]" />
        not responding
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className="gata-live-dot h-1.5 w-1.5 rounded-full"
        style={{
          background: health.catchingUp
            ? "var(--gata-amber, #F5C66B)"
            : "var(--gata-green)",
        }}
      />
      {health.catchingUp ? "catching up" : "up"}
      {health.height !== null ? (
        <span className="tabular-nums">· {health.height.toLocaleString()}</span>
      ) : null}
      {health.latencyMs !== null ? (
        <span className="tabular-nums">· {health.latencyMs}ms</span>
      ) : null}
    </span>
  );
}
