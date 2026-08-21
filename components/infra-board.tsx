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

/** A copyable block of config, shown with its own copy control. */
export interface CodeSpec {
  label: string;
  text: string;
}

export interface ListSpec {
  /** `<node-id>@<host>:<port>`, one per line when copied. */
  entries: string[];
  /** What this list is for, in a sentence. */
  note: string;
  /** The config.toml key, so it is obvious where the value goes. */
  key: string;
}

export interface InfraSpec {
  endpoints: EndpointSpec[];
  stateSync: {
    trustHeight: number;
    trustHash: string;
    rows: { label: string; value: string; mono?: boolean }[];
    snippet: string;
  } | null;
  seeds: ListSpec;
  peers: ListSpec;
  snapshot: {
    live: boolean;
    /** Absent until we have actually published for this chain. */
    url?: string;
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
  const openStateSync = open === "statesync" && spec.stateSync ? spec.stateSync : null;
  const openList =
    open === "seeds" ? spec.seeds : open === "peers" ? spec.peers : null;

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

        {spec.stateSync ? (
          <BrickButton
            accent={accent}
            brick={{
              label: "State sync",
              value: spec.stateSync.trustHeight.toLocaleString(),
              sub: "trust height, live",
              tone: "ok",
              count: spec.stateSync.rows.length,
            }}
            onClick={() => setOpen("statesync")}
          />
        ) : null}

        <BrickButton
          accent={accent}
          brick={{
            label: "Seeds",
            value: String(spec.seeds.entries.length),
            sub: spec.seeds.entries.length === 0 ? "none published" : "for discovery",
            count: spec.seeds.entries.length || undefined,
          }}
          onClick={() => setOpen("seeds")}
        />

        <BrickButton
          accent={accent}
          brick={{
            label: "Peers",
            value: String(spec.peers.entries.length),
            sub: spec.peers.entries.length === 0 ? "none published" : "persistent",
            count: spec.peers.entries.length || undefined,
          }}
          onClick={() => setOpen("peers")}
        />

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

        {spec.endpoints.length === 0 ? (
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
                        {openSnapshot.url ?? "not published yet"}
                      </span>
                      {openSnapshot.live && openSnapshot.url ? (
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
        open={openStateSync !== null}
        onClose={() => setOpen(null)}
        title="State sync"
        sub="recomputed on every load"
        accent={accent}
      >
        {openStateSync ? (
          <>
            <PopupRows rows={openStateSync.rows} />
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                  config.toml
                </span>
                <CopyButton value={openStateSync.snippet} label="state sync config" />
              </div>
              <pre className="overflow-x-auto border border-border bg-[var(--gata-bg2)] p-2.5 font-mono text-[11px] leading-relaxed">
                {openStateSync.snippet}
              </pre>
            </div>
          </>
        ) : null}
      </Popup>

      <Popup
        open={openList !== null}
        onClose={() => setOpen(null)}
        title={open === "seeds" ? "Seeds" : "Persistent peers"}
        sub={openList?.key}
        accent={accent}
      >
        {openList ? (
          <>
            <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
              {openList.note}
            </p>
            {openList.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None published for this chain.
              </p>
            ) : (
              <>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                    {openList.key}
                  </span>
                  <CopyButton
                    value={openList.entries.join(",")}
                    label={open === "seeds" ? "seeds" : "peers"}
                  />
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all border border-border bg-[var(--gata-bg2)] p-2.5 font-mono text-[11px] leading-relaxed">
                  {openList.entries.join("\n")}
                </pre>
              </>
            )}
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
