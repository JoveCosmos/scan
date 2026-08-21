"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brick, BrickButton, BrickGrid, type BrickVisual } from "@/components/brick";
import { Popup, PopupRows } from "@/components/ui/popup";
import { CopyButton } from "@/components/copy-button";

/**
 * The Infra tab: what we run for a chain, rather than what the chain is.
 *
 * This was a dialog hanging off the bottom of the landing page, which put a
 * chain's endpoints on a page about searching and made them reachable only by
 * finding a button below the fold. They belong to the chain, so they live on
 * the chain.
 *
 * Endpoint health is the one thing here that moves, so it is the only thing
 * polled. Everything else is configuration and arrives with the page.
 */

export interface EndpointSpec {
  label: string;
  url: string;
  kind: "rpc" | "rest" | "grpc";
  note?: string;
}

export interface InfraSpec {
  endpoints: EndpointSpec[];
  snapshot: {
    live: boolean;
    url: string;
    rows: { label: string; value: string; mono?: boolean }[];
    /** Restore commands, built on the server where the daemon and home are known. */
    script: string | null;
    headline: string;
    sub: string;
  } | null;
  indexer: { indexed: boolean; rows: { label: string; value: string; mono?: boolean }[] };
}

interface Health {
  url: string;
  ok: boolean;
  latencyMs: number | null;
  height: number | null;
  catchingUp: boolean | null;
  checkable: boolean;
}

function healthVisual(health: Health | undefined): {
  value: string;
  sub: string;
  tone?: BrickVisual["tone"];
} {
  if (!health) return { value: "…", sub: "checking" };
  if (!health.checkable) return { value: "grpc", sub: "not checked" };
  if (!health.ok) return { value: "down", sub: "not responding", tone: "bad" };
  return {
    value: health.height ? health.height.toLocaleString() : "up",
    sub: [
      health.catchingUp ? "catching up" : "up",
      health.latencyMs !== null ? `${health.latencyMs}ms` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    tone: health.catchingUp ? undefined : "ok",
  };
}

export function InfraBoard({
  chainId,
  accent,
  spec,
}: {
  chainId: string;
  accent: string;
  spec: InfraSpec;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const { data } = useQuery<{ endpoints: Health[] }>({
    queryKey: ["svc-health", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/services/${chainId}/health`);
      if (!res.ok) throw new Error("health unavailable");
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    enabled: spec.endpoints.length > 0,
  });

  const health = new Map((data?.endpoints ?? []).map((h) => [h.url, h]));

  const openEndpoint = spec.endpoints.find((e) => `ep:${e.url}` === open) ?? null;
  const openSnapshot = open === "snapshot" && spec.snapshot ? spec.snapshot : null;
  const openIndexer = open === "indexer";

  const nothing =
    spec.endpoints.length === 0 && !spec.snapshot && !spec.indexer.indexed;

  return (
    <>
      <BrickGrid>
        {spec.endpoints.map((endpoint) => {
          const visual = healthVisual(health.get(endpoint.url));
          return (
            <BrickButton
              key={endpoint.url}
              accent={accent}
              brick={{
                label: endpoint.label,
                value: visual.value,
                sub: visual.sub,
                tone: visual.tone,
              }}
              onClick={() => setOpen(`ep:${endpoint.url}`)}
            />
          );
        })}

        {spec.snapshot ? (
          <BrickButton
            accent={accent}
            brick={{
              label: "Snapshot",
              value: spec.snapshot.headline,
              sub: spec.snapshot.sub,
              tone: spec.snapshot.live ? "ok" : undefined,
              count: spec.snapshot.rows.length,
            }}
            onClick={() => setOpen("snapshot")}
          />
        ) : null}

        <BrickButton
          accent={accent}
          brick={{
            label: "Indexer",
            value: spec.indexer.indexed ? "indexed" : "not indexed",
            sub: spec.indexer.indexed ? "history in Postgres" : "live reads only",
            tone: spec.indexer.indexed ? "ok" : undefined,
            count: spec.indexer.rows.length,
          }}
          onClick={() => setOpen("indexer")}
        />

        {nothing ? (
          <Brick
            accent={accent}
            brick={{
              label: "Endpoints",
              value: "—",
              sub: "none published for this chain",
            }}
          />
        ) : null}
      </BrickGrid>

      <Popup
        open={openEndpoint !== null}
        onClose={() => setOpen(null)}
        title={openEndpoint?.label ?? ""}
        sub={openEndpoint?.kind.toUpperCase()}
        accent={accent}
      >
        {openEndpoint ? (
          <>
            <PopupRows
              rows={[
                {
                  label: "URL",
                  mono: true,
                  value: (
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 break-all">{openEndpoint.url}</span>
                      <CopyButton
                        value={openEndpoint.url}
                        label={`${openEndpoint.label} endpoint`}
                      />
                    </span>
                  ),
                },
                {
                  label: "Status",
                  mono: true,
                  value: healthVisual(health.get(openEndpoint.url)).sub,
                },
                ...(health.get(openEndpoint.url)?.height
                  ? [
                      {
                        label: "Height",
                        mono: true,
                        value: health
                          .get(openEndpoint.url)!
                          .height!.toLocaleString(),
                      },
                    ]
                  : []),
                ...(openEndpoint.note
                  ? [{ label: "Note", value: openEndpoint.note }]
                  : []),
                { label: "Checked", value: "Every 30 seconds, from your browser." },
              ]}
            />
          </>
        ) : null}
      </Popup>

      <Popup
        open={openSnapshot !== null}
        onClose={() => setOpen(null)}
        title="Snapshot"
        sub={openSnapshot?.live ? "available" : "coming soon"}
        accent={accent}
      >
        {openSnapshot ? (
          <>
            <PopupRows
              rows={[
                ...openSnapshot.rows.map((r) => ({
                  label: r.label,
                  mono: r.mono,
                  value: r.value,
                })),
                {
                  label: "Download",
                  mono: true,
                  value: (
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`min-w-0 break-all ${
                          openSnapshot.live ? "" : "text-muted-foreground line-through"
                        }`}
                      >
                        {openSnapshot.url}
                      </span>
                      {openSnapshot.live ? (
                        <CopyButton value={openSnapshot.url} label="snapshot URL" />
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
            {openSnapshot.script ? (
              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                    Restore
                  </span>
                  <CopyButton value={openSnapshot.script} label="restore commands" />
                </div>
                <pre className="overflow-x-auto border border-border bg-[var(--gata-bg2)] p-2.5 font-mono text-[11px] leading-relaxed">
                  {openSnapshot.script}
                </pre>
              </div>
            ) : null}
          </>
        ) : null}
      </Popup>

      <Popup
        open={openIndexer}
        onClose={() => setOpen(null)}
        title="Indexer"
        sub={spec.indexer.indexed ? "indexed" : "not indexed"}
        accent={accent}
      >
        <PopupRows rows={spec.indexer.rows} />
      </Popup>
    </>
  );
}
