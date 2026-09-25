"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Download } from "lucide-react";
import { CopyButton } from "@/components/copy-button";

/**
 * The Infra tab: what we run for a chain, rather than what the chain is.
 *
 * Everything is on the page, in plain panels. It used to be bricks that opened
 * popups, which meant a click to learn a URL and another to find the checksum;
 * an operator reading this wants to copy three things and leave, so nothing is
 * behind a click any more. On a short screen the panels scroll inside the frame.
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

type Row = { label: string; value: string; mono?: boolean };

export interface InfraSpec {
  endpoints: EndpointSpec[];
  /** The directory listing every archive we publish for this chain. */
  snapshotsDir: string | null;
  stateSync: {
    rows: Row[];
    snippet: string;
  } | null;
  snapshot: {
    live: boolean;
    /** Absent until we have actually published for this chain. */
    url?: string;
    rows: Row[];
    /** Restore commands, built on the server where the daemon and home are known. */
    script: string | null;
  } | null;
  indexer: { indexed: boolean; rows: Row[] };
}

interface Health {
  url: string;
  ok: boolean;
  latencyMs: number | null;
  height: number | null;
  catchingUp: boolean | null;
  checkable: boolean;
}

/** Where the hub lists every network's endpoints and snapshots together. */
const HUB_INFRA = "https://gatahub.zone/#infrastructure";

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="gata-panel min-w-0 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="divide-y divide-border/50">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[7.5rem_1fr] gap-3 py-1.5 text-[13px]"
        >
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={`min-w-0 break-words ${row.mono ? "font-mono text-[12px]" : ""}`}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Code({ text, label }: { text: string; label: string }) {
  return (
    <div className="relative mt-2 rounded-lg border border-border bg-[var(--gata-bg2)]">
      <div className="absolute right-1.5 top-1.5">
        <CopyButton value={text} label={label} />
      </div>
      <pre className="overflow-x-auto p-3 pr-9 font-mono text-[11.5px] leading-relaxed text-foreground/90">
        {text}
      </pre>
    </div>
  );
}

function HealthMark({ health }: { health: Health | undefined }) {
  if (!health) return <span className="text-muted-foreground">checking…</span>;
  if (!health.checkable) return <span className="text-muted-foreground">not checked</span>;
  if (!health.ok) return <span className="text-[var(--gata-burn)]">down</span>;
  return (
    <span className="text-[var(--gata-green)]">
      {health.catchingUp ? "catching up" : "up"}
      <span className="text-muted-foreground">
        {health.height ? ` · #${health.height.toLocaleString()}` : ""}
        {health.latencyMs !== null ? ` · ${health.latencyMs}ms` : ""}
      </span>
    </span>
  );
}

export function InfraBoard({
  chainId,
  spec,
}: {
  chainId: string;
  accent: string;
  spec: InfraSpec;
}) {
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

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="gap-3 lg:columns-2 [&>section]:mb-3 [&>section]:break-inside-avoid">
        <Panel
          title="Endpoints"
          action={
            <a
              href={HUB_INFRA}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              All networks on GATA HUB <ArrowUpRight className="h-3 w-3" />
            </a>
          }
        >
          {spec.endpoints.length === 0 && !spec.snapshotsDir ? (
            <p className="py-1.5 text-[13px] text-muted-foreground">
              N/A
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {spec.endpoints.map((e) => (
                <li key={e.url} className="py-2">
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="font-medium">{e.label}</span>
                    <span className="text-[11px]">
                      <HealthMark health={health.get(e.url)} />
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noopener"
                      className="min-w-0 truncate font-mono text-[12px] text-primary hover:underline"
                    >
                      {e.url}
                    </a>
                    <CopyButton value={e.url} label={`${e.label} URL`} />
                  </div>
                  {e.note ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{e.note}</p>
                  ) : null}
                </li>
              ))}
              {spec.snapshotsDir ? (
                <li className="py-2">
                  <div className="text-[13px] font-medium">Snapshots</div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <a
                      href={spec.snapshotsDir}
                      target="_blank"
                      rel="noopener"
                      className="min-w-0 truncate font-mono text-[12px] text-primary hover:underline"
                    >
                      {spec.snapshotsDir}
                    </a>
                    <CopyButton value={spec.snapshotsDir} label="snapshot directory" />
                  </div>
                </li>
              ) : null}
            </ul>
          )}
        </Panel>

        <Panel
          title="Snapshot"
          action={
            spec.snapshot?.live && spec.snapshot.url ? (
              <a
                href={spec.snapshot.url}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:border-[var(--gata-border-hi)]"
              >
                <Download className="h-3 w-3" /> Download
              </a>
            ) : null
          }
        >
          {spec.snapshot ? (
            <>
              <Rows rows={spec.snapshot.rows} />
              {spec.snapshot.script ? (
                <Code text={spec.snapshot.script} label="restore commands" />
              ) : null}
            </>
          ) : (
            <p className="py-1.5 text-[13px] text-muted-foreground">
              N/A
            </p>
          )}
        </Panel>

        {spec.stateSync ? (
          <Panel title="State sync">
            <Rows rows={spec.stateSync.rows} />
            <Code text={spec.stateSync.snippet} label="state sync config" />
          </Panel>
        ) : null}

        <Panel title="Indexer">
          <Rows rows={spec.indexer.rows} />
        </Panel>
      </div>
    </div>
  );
}
