import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink, ArrowLeft } from "lucide-react";
import { getChain, accentFor } from "@/lib/chains";
import { getServices, type ChainServices } from "@/lib/services";
import { CopyButton } from "@/components/copy-button";

export const metadata: Metadata = {
  // The layout appends the site name; repeating it here read as "Public Goods ·
  // GATA HUB · GATA HUB Explorer".
  title: "Public goods",
  description:
    "Public endpoints, snapshots, live peers and node guides operated by GATA HUB.",
};

export const revalidate = 300;

/**
 * What we run and offer back to the networks we validate on.
 *
 * Everything here is driven by config/services.json, and anything not
 * configured is not rendered. An endpoint we do not operate must never appear
 * as one we do — a dead RPC in someone's config.toml is worse than no page.
 */
export default function PublicGoodsPage() {
  const services = getServices();
  const chains = services.chains.filter((c) => getChain(c.chainId));

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <h1 className="mt-4 text-2xl font-medium">Public goods</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Infrastructure we run and offer freely to the networks we validate on.
        Free to use, no key or registration required.
      </p>

      {chains.length === 0 ? (
        <div className="gata-panel mt-8 px-5 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing published yet.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-10">
          {chains.map((c) => (
            <ChainSection key={c.chainId} services={c} />
          ))}
        </div>
      )}

      <p className="mt-10 text-xs text-muted-foreground">
        Offered as-is, with no uptime guarantee. For anything you depend on, run
        your own node.
      </p>
    </main>
  );
}

function ChainSection({ services }: { services: ChainServices }) {
  const chain = getChain(services.chainId)!;
  const accent = accentFor(chain);
  const { endpoints, snapshot, guide } = services;

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
        />
        <h2 className="text-lg font-medium">{chain.prettyName}</h2>
        <Link
          href={`/${chain.chainId}/validators`}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          explorer →
        </Link>
        {/* The project's own links, from its chain config — these belong to the
            chain, not to us, and are the same wherever it appears. */}
        {chain.website ? (
          <ExternalLinkRow href={chain.website} label="website" small />
        ) : null}
        {chain.repo ? (
          <ExternalLinkRow href={chain.repo} label="source" small />
        ) : null}
      </div>

      <div className="space-y-4">
        {endpoints.length > 0 ? (
          <div
            className="gata-panel"
            style={{ ["--panel-accent" as string]: accent }}
          >
            <h3 className="border-b border-border px-4 py-3 text-sm font-medium">
              Endpoints
            </h3>
            <ul className="divide-y divide-border/50">
              {endpoints.map((e) => (
                <li
                  key={e.url}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{e.label}</div>
                    <code className="block truncate font-mono text-sm">
                      {e.url}
                    </code>
                    {e.note ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {e.note}
                      </div>
                    ) : null}
                  </div>
                  <CopyButton value={e.url} label={`${e.label} endpoint`} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {snapshot ? (
          <div
            className="gata-panel px-4 py-4"
            style={{ ["--panel-accent" as string]: accent }}
          >
            <h3 className="text-sm font-medium">Snapshot</h3>
            <div className="mt-2 flex items-center justify-between gap-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">
                {snapshot.url}
              </code>
              <CopyButton value={snapshot.url} label="snapshot URL" />
            </div>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              {snapshot.schedule ? (
                <div>
                  <dt className="inline">Taken </dt>
                  <dd className="inline text-foreground">{snapshot.schedule}</dd>
                </div>
              ) : null}
              {snapshot.pruning ? (
                <div>
                  <dt className="inline">Pruning </dt>
                  <dd className="inline text-foreground">{snapshot.pruning}</dd>
                </div>
              ) : null}
            </dl>
            {snapshot.note ? (
              <p className="mt-2 text-xs text-muted-foreground">{snapshot.note}</p>
            ) : null}
          </div>
        ) : null}

        {guide ? (
          <a
            href={guide}
            target="_blank"
            rel="noreferrer"
            className="gata-panel flex items-center justify-between px-4 py-3 transition-colors hover:border-[var(--gata-border-hi)]"
            style={{ ["--panel-accent" as string]: accent }}
          >
            <span className="text-sm">
              Node installation guide
              <span className="ml-2 text-xs text-muted-foreground">
                setup, sync and joining {chain.prettyName}
              </span>
            </span>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          </a>
        ) : null}
      </div>
    </section>
  );
}

function ExternalLinkRow({
  href,
  label,
  small,
}: {
  href: string;
  label: string;
  small?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground ${
        small ? "text-xs" : "text-sm"
      }`}
    >
      {label}
      <ExternalLink className={small ? "h-3 w-3" : "h-3.5 w-3.5"} />
    </a>
  );
}
