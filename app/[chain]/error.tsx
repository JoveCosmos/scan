"use client";

import { Button } from "@/components/ui/button";

export default function ChainOverviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex h-full max-w-6xl flex-col items-start justify-center gap-4 px-4">
      <h2 className="text-xl font-semibold">Failed to load chain data</h2>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      <Button onClick={() => reset()}>Try again</Button>
    </main>
  );
}
