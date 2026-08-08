"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ChainOverview } from "@/lib/overview";
import { timeAgo } from "@/lib/format";

function useSecondsTicker() {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

function StatCard({
  label,
  value,
  sub,
  accent,
  flash,
  index,
  sheen,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent: string;
  flash?: boolean;
  index: number;
  sheen?: boolean;
}) {
  return (
    <div
      className={cn(
        "gata-panel gata-panel-interactive gata-rise p-5",
        sheen && "gata-sheen"
      )}
      style={{
        ["--panel-accent" as string]: accent,
        ["--panel-glow" as string]: `${accent}1f`,
        animationDelay: `${index * 60}ms`,
      }}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className="mt-2 font-mono text-3xl font-semibold leading-none transition-[text-shadow] duration-500"
        style={flash ? { textShadow: `0 0 18px ${accent}` } : undefined}
      >
        {value}
      </p>
      {sub ? <p className="mt-2 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function LiveOverview({
  chainId,
  accent,
  initialData,
}: {
  chainId: string;
  accent: string;
  initialData: ChainOverview;
}) {
  const { data, isFetching, isError } = useQuery<ChainOverview>({
    queryKey: ["chain-head", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/chains/${chainId}/head`, { cache: "no-store" });
      if (!res.ok) throw new Error(`head request failed: ${res.status}`);
      return res.json();
    },
    initialData,
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
  });

  // Re-render each second so "Xs ago" stays truthful between polls.
  useSecondsTicker();

  const prevHeight = useRef(data.height);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (data.height && data.height !== prevHeight.current) {
      prevHeight.current = data.height;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 600);
      return () => clearTimeout(id);
    }
  }, [data.height]);

  const live = !isError;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="relative flex h-2 w-2">
          {live ? (
            <span className="gata-live-dot absolute inline-flex h-full w-full rounded-full bg-[var(--gata-green)]" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              live ? "bg-[var(--gata-green)]" : "bg-[var(--gata-burn)]"
            )}
          />
        </span>
        <span>{live ? "Live" : "Connection lost - retrying"}</span>
        {isFetching && live ? <span className="opacity-50">· syncing</span> : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          index={0}
          accent={accent}
          sheen
          label="Latest Block"
          value={data.height ? Number(data.height).toLocaleString() : "—"}
          sub={timeAgo(data.blockTime)}
          flash={flash}
        />
        <StatCard
          index={1}
          accent={accent}
          label="Txs in Block"
          value={data.txCount ?? "—"}
          sub="at current height"
        />
      </div>
    </div>
  );
}
