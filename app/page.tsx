import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getAllChains } from "@/lib/chains";

export default function HomePage() {
  const chains = getAllChains();

  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Cosmos Explorer</h1>
      <p className="mt-2 text-muted-foreground">Select a chain to explore.</p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {chains.map((chain) => (
          <Link key={chain.chainId} href={`/${chain.chainId}`}>
            <Card className="transition-colors hover:border-primary">
              <CardHeader>
                <CardTitle>{chain.prettyName}</CardTitle>
                <CardDescription>{chain.chainId}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
