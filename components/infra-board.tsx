"use client";

import { useQuery } from "@tanstack/react-query";
import { CopyButton } from "@/components/copy-button";
import { timeAgo } from "@/lib/format";

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
}

interface Health {
  url: string;
  ok: boolean;
  latencyMs: number | null;
  height: number | null;
  catchingUp: boolean | null;
  checkable: boolean;
  /** Snapshots folder only: when its newest archive was written. */
  takenAt?: string | null;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="gata-panel min-w-0 px-4 py-3">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </h2>
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

function HealthMark({
  health,
  snapshot = false,
}: {
  health: Health | undefined;
  /** The snapshots folder: its height is the newest archive's, with its age. */
  snapshot?: boolean;
}) {
  if (!health) return <span className="text-muted-foreground">checking…</span>;
  if (!health.checkable) return <span className="text-muted-foreground">not checked</span>;
  if (!health.ok) return <span className="text-[var(--gata-burn)]">down</span>;
  return (
    <span className="text-[var(--gata-green)]">
      {health.catchingUp ? "catching up" : "up"}
      <span className="text-muted-foreground">
        {health.height
          ? ` · ${snapshot ? "latest " : ""}#${health.height.toLocaleString("en-US")}`
          : ""}
        {snapshot && health.takenAt ? ` · ${timeAgo(health.takenAt)}` : ""}
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
    enabled: spec.endpoints.length > 0 || spec.snapshotsDir !== null,
  });
  const health = new Map((data?.endpoints ?? []).map((h) => [h.url, h]));

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div
        className={`gap-3 [&>section]:mb-3 [&>section]:break-inside-avoid ${
          spec.stateSync ? "lg:columns-2" : ""
        }`}
      >
        <Panel title="Endpoints">
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
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="font-medium">Snapshots</span>
                    <span className="text-[11px]">
                      <HealthMark health={health.get(spec.snapshotsDir)} snapshot />
                    </span>
                  </div>
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

        {spec.stateSync ? (
          <Panel title="State sync">
            <Rows rows={spec.stateSync.rows} />
            <Code text={spec.stateSync.snippet} label="state sync config" />
          </Panel>
        ) : null}

      </div>
    </div>
  );
}
