import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getChain, accentFor } from "@/lib/chains";
import { servicesFor } from "@/lib/services";
import { CopyButton } from "@/components/copy-button";
import { EndpointList } from "@/components/endpoint-list";

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
      <h1 className="text-xl font-medium">{chain.prettyName} public goods</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Infrastructure we run for {chain.prettyName} and offer freely. No key or
        registration required.
      </p>

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

          {services.snapshot ? (
            <div
              className="gata-panel px-4 py-4"
              style={{ ["--panel-accent" as string]: accent }}
            >
              <h3 className="text-sm font-medium">Snapshot</h3>
              <div className="mt-2 flex items-center justify-between gap-3">
                <code className="min-w-0 flex-1 truncate font-mono text-sm">
                  {services.snapshot.url}
                </code>
                <CopyButton value={services.snapshot.url} label="snapshot URL" />
              </div>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                {services.snapshot.schedule ? (
                  <div>
                    <dt className="inline">Taken </dt>
                    <dd className="inline text-foreground">
                      {services.snapshot.schedule}
                    </dd>
                  </div>
                ) : null}
                {services.snapshot.pruning ? (
                  <div>
                    <dt className="inline">Pruning </dt>
                    <dd className="inline text-foreground">
                      {services.snapshot.pruning}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {services.snapshot.note ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {services.snapshot.note}
                </p>
              ) : null}
            </div>
          ) : null}

          <QuickStart chain={chain.prettyName} endpoints={services.endpoints} />

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

      <p className="mt-8 text-xs text-muted-foreground">
        Offered as-is, with no uptime guarantee. For anything you depend on, run
        your own node.
      </p>
    </main>
  );
}

/**
 * The short version, inline. Someone who just wants to point a wallet or a
 * script at an endpoint should not have to open a guide to find out how.
 */
function QuickStart({
  chain,
  endpoints,
}: {
  chain: string;
  endpoints: { url: string; kind: "rpc" | "rest" | "grpc" }[];
}) {
  const rpc = endpoints.find((e) => e.kind === "rpc")?.url;
  if (!rpc) return null;

  const check = `curl -s ${rpc}/status | jq '.result.sync_info'`;

  return (
    <details className="gata-panel px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        Quick start
      </summary>
      <div className="mt-3 space-y-3 text-xs text-muted-foreground">
        <div>
          <p className="mb-1">Check the endpoint is answering and in sync:</p>
          <div className="flex items-center justify-between gap-2 rounded border border-border bg-secondary/40 px-3 py-2">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-foreground">
              {check}
            </code>
            <CopyButton value={check} label="status command" />
          </div>
        </div>
        <p>
          A <code className="font-mono">catching_up</code> of{" "}
          <code className="font-mono">false</code> means the node is at the head
          of {chain} and safe to read from.
        </p>
      </div>
    </details>
  );
}
