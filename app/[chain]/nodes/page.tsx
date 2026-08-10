import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getChain, accentFor } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
import { EndpointList } from "@/components/endpoint-list";
import { SnapshotPanel } from "@/components/snapshot-panel";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return {
    title: chain ? `${chain.prettyName} public goods` : "Public goods",
    description: chain
      ? `Public endpoints and snapshots for ${chain.prettyName}, operated by GATA HUB.`
      : undefined,
  };
}

/**
 * What we run for one network.
 *
 * Per chain rather than one combined page, because that is how the rest of the
 * explorer is organised and how the question is actually asked — someone
 * setting up an AtomOne node does not want gno.land's endpoints in the way.
 */
export default async function NodesPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const services = servicesFor(chainId);
  const accent = accentFor(chain);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-xl font-medium">{chain.prettyName}</h1>

      {!services || services.endpoints.length === 0 ? (
        <div className="gata-panel mt-6 px-5 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            We do not publish anything for {chain.prettyName} yet.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <EndpointList
            chainId={chainId}
            endpoints={services.endpoints}
            accent={accent}
          />

          <SnapshotPanel
            services={services}
            accent={accent}
            chainName={chain.prettyName}
          />

          {services.guide ? (
            <a
              href={services.guide}
              target="_blank"
              rel="noreferrer"
              className="gata-panel flex items-center justify-between px-4 py-3 transition-colors hover:border-[var(--gata-border-hi)]"
              style={{ ["--panel-accent" as string]: accent }}
            >
              <span className="text-sm">Full installation guide</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </a>
          ) : null}
        </div>
      )}
    </main>
  );
}
