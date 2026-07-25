"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardDescription, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatToken, type ChainOverview } from "@/lib/overview";
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
  flash,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  flash?: boolean;
}) {
  return (
    <Card
      className={cn(
        "transition-colors duration-500",
        flash && "border-primary/60 bg-primary/5"
      )}
    >
      <CardHeader className="gap-1">
        <CardDescription className="text-xs uppercase tracking-wider">
          {label}
        </CardDescription>
        <CardTitle className="font-mono text-3xl tabular-nums">{value}</CardTitle>
        {sub ? (
          <p className="text-xs text-muted-foreground">{sub}</p>
        ) : null}
      </CardHeader>
    </Card>
  );
}

export function LiveOverview({
  chainId,
  exponent,
  symbol,
  initialData,
}: {
  chainId: string;
  exponent: number;
  symbol: string;
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

  // Flash the height card whenever a new block lands.
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
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              live ? "bg-emerald-500" : "bg-red-500"
            )}
          />
        </span>
        <span>{live ? "Live" : "Connection lost — retrying"}</span>
        {isFetching && live ? <span className="opacity-60">· syncing</span> : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Latest Block"
          value={data.height ? Number(data.height).toLocaleString() : "—"}
          sub={timeAgo(data.blockTime)}
          flash={flash}
        />
        <StatCard
          label="Txs in Block"
          value={data.txCount ?? "—"}
          sub="current height"
        />
        <StatCard
          label="Active Validators"
          value={data.activeValidators ?? "—"}
          sub="bonded set"
        />
        <StatCard
          label="Bonded Ratio"
          value={
            data.bondedRatio === null ? "—" : `${(data.bondedRatio * 100).toFixed(2)}%`
          }
          sub={
            data.bondedTokens
              ? `${formatToken(data.bondedTokens, exponent)} ${symbol} staked`
              : undefined
          }
        />
      </div>
    </div>
  );
}
