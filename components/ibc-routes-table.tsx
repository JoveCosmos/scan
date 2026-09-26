import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { getChain } from "@/lib/chains";
import { packetStats } from "@/lib/indexer-tx";
import { routeHealth, routeIsLive, type SideHealth } from "@/lib/ibc-routes";

/**
 * The routes this chain keeps open, and whether each one works right now.
 *
 * Channel state alone is misleading — a route reads OPEN on both sides while
 * one light client has quietly expired, and nothing passes until someone
 * recovers it. So the verdict comes from both clients and both channels
 * together, and the parts are shown underneath so a failure says which end.
 */
export async function IbcRoutesTable({ chainId }: { chainId: string }) {
  const routes = await routeHealth(chainId);

  if (routes.length === 0) {
    return (
      <div className="gata-panel px-5 py-7 text-center">
        <p className="font-mono text-sm uppercase tracking-[0.14em] text-[var(--gata-faint)]">
          N/A
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {routes.map((route) => {
        const live = routeIsLive(route);
        return (
          <div
            key={`${route.a.chainId}-${route.a.channelId}-${route.b.chainId}`}
            className="gata-panel px-4 py-4"
            style={{ ["--panel-accent" as string]: route.b.accent }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 text-sm">
                <Dot accent={route.a.accent} />
                <ChainName side={route.a} />
                <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
                <Dot accent={route.b.accent} />
                <ChainName side={route.b} />
              </div>
              <Verdict live={live} route={route} />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SidePanel side={route.a} />
              <SidePanel side={route.b} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Verdict({
  live,
  route,
}: {
  live: boolean;
  route: { a: SideHealth; b: SideHealth };
}) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--gata-green)]">
        <span className="gata-live-dot h-1.5 w-1.5 rounded-full bg-[var(--gata-green)]" />
        Carrying traffic
      </span>
    );
  }

  const unreachable =
    route.a.clientStatus === null || route.b.clientStatus === null;
  const expired = [route.a, route.b].find(
    (s) => s.clientStatus === "Expired" || s.clientStatus === "Frozen"
  );

  if (expired) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--gata-burn)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--gata-burn)]" />
        {expired.prettyName} client {(expired.clientStatus ?? "").toLowerCase()}
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground">
      {unreachable ? "N/A" : "not carrying traffic"}
    </span>
  );
}

function SidePanel({ side }: { side: SideHealth }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Dot accent={side.accent} />
        <span className="text-xs text-muted-foreground">
          <ChainName side={side} />
        </span>
      </div>

      <dl className="mt-2 space-y-1 text-xs">
        <Row label="Port" value={side.portId} mono />
        <Row label="Channel" value={side.channelId} mono />
        <Row label="Connection" value={side.connectionId} mono />
        <Row
          label="Client"
          value={side.clientId}
          mono
          badge={side.clientStatus ?? undefined}
          bad={side.clientStatus === "Expired" || side.clientStatus === "Frozen"}
        />
        <Row
          label="Pending"
          value={
            side.pendingPackets === null
              ? "-"
              : side.pendingPackets.toLocaleString()
          }
          // A pile of uncleared commitments is the sign that no relayer is
          // working the channel. A handful is just traffic in flight.
          bad={side.pendingPackets !== null && side.pendingPackets > 50}
        />
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  badge,
  bad,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: string;
  bad?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`flex items-center gap-1.5 ${mono ? "font-mono" : "tabular-nums"} ${
          bad ? "text-[var(--gata-burn)]" : ""
        }`}
      >
        {value}
        {badge ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              bad
                ? "bg-[var(--gata-burn)]/10 text-[var(--gata-burn)]"
                : "bg-secondary text-muted-foreground"
            }`}
          >
            {badge}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

/** A route's chain, linked to its own relayers page when we carry it. */
function ChainName({ side }: { side: SideHealth }) {
  if (!getChain(side.chainId)) return <span className="font-medium">{side.prettyName}</span>;
  return (
    <Link
      href={`/${side.chainId}/relayers`}
      className="font-medium text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
    >
      {side.prettyName}
    </Link>
  );
}

function Dot({ accent }: { accent: string }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
    />
  );
}

/**
 * Per-channel packet health over the last 30 days, from the index: packets
 * each way, acknowledgement errors, timeouts and the median time to deliver.
 * Renders nothing where the index doesn't cover packets.
 */
export async function ChannelHealth({ chainId }: { chainId: string }) {
  const stats = await packetStats(chainId, 30).catch(() => null);
  if (!stats) {
    return (
      <p className="py-6 text-center font-mono text-sm uppercase tracking-[0.14em] text-[var(--gata-faint)]">
        N/A
      </p>
    );
  }
  return (
    <div className="gata-surface overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[13px] tabular-nums">
        <thead className="bg-[var(--gata-bg2)]">
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            <th className="px-3 py-2 font-medium">Channel</th>
            <th className="px-3 py-2 font-medium">Direction</th>
            <th className="px-3 py-2 text-right font-medium">Packets 30d</th>
            <th className="px-3 py-2 text-right font-medium">Ack errors</th>
            <th className="px-3 py-2 text-right font-medium">Timeouts</th>
            <th className="px-3 py-2 text-right font-medium">Median</th>
          </tr>
        </thead>
        <tbody>
          {stats.channels.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                No packets
              </td>
            </tr>
          ) : (
            stats.channels.map((c) => (
              <tr key={`${c.channel}-${c.direction}`} className="border-b border-border/40 last:border-0">
                <td className="px-3 py-1.5 font-mono">{c.channel}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{c.direction === "out" ? "sent" : "received"}</td>
                <td className="px-3 py-1.5 text-right">{c.packets.toLocaleString()}</td>
                <td className={`px-3 py-1.5 text-right ${c.errors > 0 ? "text-[var(--destructive)]" : "text-muted-foreground"}`}>
                  {c.errors.toLocaleString()}
                </td>
                <td className={`px-3 py-1.5 text-right ${c.timeouts > 0 ? "text-[var(--destructive)]" : "text-muted-foreground"}`}>
                  {c.timeouts.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right text-muted-foreground">
                  {c.medianLatency !== null ? `${c.medianLatency}s` : "—"}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
