import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, accentFor, symbolFor, type ChainConfig } from "@/lib/chains";
import {
  gnoDeploys,
  gnoDoc,
  gnoFuncs,
  gnoPackage,
  gnoRealmCalls,
  gnoRender,
  gnoSources,
  gnoStorage,
  isPackagePath,
  callsPage,
  isRealm,
  realmAddress,
  shortPath,
  type GnoPackage,
} from "@/lib/gno-packages";
import { withinBudget } from "@/lib/cache";
import { tokenHref } from "@/lib/gno-tokens";
import { tokenList } from "@/lib/gno-token-data";
import { atName, gnoNames } from "@/lib/gno-users";
import { formatToken } from "@/lib/overview";
import { decodeParam, formatDate, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck, type DeckRow } from "@/components/row-deck";
import { SourceView } from "@/components/source-view";
import { OlderDeck } from "@/components/older-deck";
import { CALL_COLUMNS, callRows } from "../rows";
import { BrickLoading } from "@/components/brick-loading";
import { LoadingPanel } from "@/components/loading-panel";
import { Prose } from "@/components/prose";
import { DetailRow } from "@/components/detail-row";
import { AddressLink } from "@/components/address-link";

export const dynamic = "force-dynamic";

const BUDGET = 4000;

/** The URL's segments as a package path; "gno.land/" may be given or not. */
function pathOf(segments: string[]): string | null {
  const parts = segments.map(decodeParam);
  if (parts[0] === "gno.land") parts.shift();
  const path = `gno.land/${parts.join("/")}`.toLowerCase();
  return isPackagePath(path) ? path : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; path: string[] }>;
}): Promise<Metadata> {
  const { chain: chainId, path } = await params;
  const chain = getChain(chainId);
  const pkg = pathOf(path);
  return { title: pkg && chain ? `${shortPath(pkg)} on ${chain.prettyName}` : "Package" };
}

const day = formatDate;

const TABS = ["overview", "source", "functions", "render", "calls"];

/**
 * One gno.land realm or package: who deployed it and when, its source, its
 * exported functions, and for a realm its rendered page and the calls made
 * to it.
 */
export default async function PackagePage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string; path: string[] }>;
  searchParams: Promise<{ tab?: string; file?: string; render?: string }>;
}) {
  const { chain: chainId, path: segments } = await params;
  const { tab, file, render: renderArg } = await searchParams;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") notFound();
  const path = pathOf(segments);
  if (!path) notFound();
  const accent = accentFor(chain);
  const realm = isRealm(path);

  // The node decides whether the package exists. When no node answers, the
  // page still renders, with N/A where the node's answers would be.
  let pkg: GnoPackage | null = null;
  try {
    pkg = await gnoPackage(chain, path);
    if (!pkg) notFound();
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    pkg = null;
  }

  const arg = typeof renderArg === "string" && renderArg.length <= 200 ? renderArg : "";
  // A realm's calls take the indexer a full scan (seconds), so they stream in
  // behind the rest of the page.
  const calls = realm ? gnoRealmCalls(chain, path) : null;
  const [sources, deploys, funcs, doc, storage, rendered] = await Promise.all([
    pkg ? withinBudget(gnoSources(chain, pkg), BUDGET * 2, null) : null,
    withinBudget(gnoDeploys(chain), BUDGET, null),
    withinBudget(gnoFuncs(chain, path), BUDGET, null),
    realm ? null : withinBudget(gnoDoc(chain, path), BUDGET, null),
    withinBudget(gnoStorage(chain, path), BUDGET, null),
    realm ? withinBudget(gnoRender(chain, path, arg), BUDGET, null) : null,
  ]);
  const names = await withinBudget(gnoNames(chain), 1500, null);
  // Tokens this realm created.
  const tokens = realm ? await withinBudget(tokenList(chain), 1000, null) : null;
  const ownTokens = (tokens ?? []).filter((t) => t.realm === path);
  const deploy = deploys?.get(path) ?? null;

  const code = (sources ?? []).filter((f) => f.name.endsWith(".gno") && !f.name.endsWith("_test.gno"));
  const lines = sources ? code.reduce((n, f) => n + (f.source ? f.source.split("\n").length : 0), 0) : null;
  const tests = (pkg?.files ?? []).filter((f) => /_(test|filetest)\.gno$/.test(f)).length;

  const bricks: BrickSpec[] = [
    {
      key: "files",
      label: "Files",
      value: pkg ? pkg.files.length.toLocaleString() : "N/A",
      sub: pkg && tests ? `${tests} test${tests === 1 ? "" : "s"}` : undefined,
      lead: true,
    },
    { key: "lines", label: "Lines of code", value: lines !== null ? lines.toLocaleString() : "N/A", sub: "gno code" },
    { key: "funcs", label: "Functions", value: funcs ? funcs.length.toLocaleString() : "N/A", sub: "exported" },
    {
      key: "storage",
      label: "Storage",
      value: storage ? `${(storage.bytes / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB` : "N/A",
      sub: storage ? `${formatToken(storage.deposit, chain.exponent)} ${symbolFor(chain)} deposit` : undefined,
    },
  ];

  const deployedBrick: BrickSpec[] = [
    {
      key: "deployed",
      label: "Deployed",
      value: deploy ? (deploy.height === 0 ? "Genesis" : day(deploy.time)) : "N/A",
      sub: deploy ? `block ${deploy.height.toLocaleString()}` : undefined,
    },
  ];

  const profile = (
    <div className="gata-surface flex shrink-0 flex-col gap-4 px-4 py-3.5">
      <section className="flex flex-col gap-1.5">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          {realm ? "Realm" : "Package"}
        </h2>
        <div className="flex flex-col divide-y divide-border/50">
          <DetailRow label="Path" copy={path}>
            <span className="font-mono">{path}</span>
          </DetailRow>
          {realm ? (
            <DetailRow label="Account" copy={realmAddress(path)}>
              <AddressLink address={realmAddress(path)} head={12} tail={8} />
            </DetailRow>
          ) : null}
          {ownTokens.length ? (
            <div className="flex min-w-0 items-center justify-between gap-2 py-1.5 text-[12px]">
              <span className="shrink-0 text-muted-foreground">Tokens</span>
              <span className="flex min-w-0 flex-wrap justify-end gap-x-2.5 gap-y-1">
                {ownTokens.map((t) => (
                  <Link key={t.key} href={tokenHref(chainId, t)} className="font-mono text-primary hover:underline">
                    {t.symbol}
                  </Link>
                ))}
              </span>
            </div>
          ) : null}
          {deploy?.creator ? (
            <DetailRow label="Deployer" copy={deploy.creator}>
              <AddressLink address={deploy.creator} label={atName(names, deploy.creator)} head={12} tail={8} />
            </DetailRow>
          ) : null}
          {deploy && deploy.height > 0 ? (
            <DetailRow label="Transaction" copy={deploy.txHash}>
              <Link href={`/${chainId}/txs/${deploy.txHash}`} className="font-mono text-primary hover:underline">
                {truncateMiddle(deploy.txHash, 10, 8)}
              </Link>
            </DetailRow>
          ) : null}
        </div>
      </section>
      {doc ? (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Documentation</h2>
          <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-foreground/85">{doc}</p>
        </section>
      ) : null}
    </div>
  );

  const funcDeck: DeckRow[] = (funcs ?? []).map((f) => {
    const params = f.params.filter((p) => p.type !== "realm");
    const crossing = params.length !== f.params.length;
    const signature = `(${params.map((p) => `${p.name} ${p.type}`).join(", ")})`;
    return {
      key: f.name,
      cells: [
        { v: f.name, mono: true, tone: "accent" },
        { v: signature, mono: true, dim: params.length === 0 },
        { v: f.results.join(", ") || "-", mono: true, dim: f.results.length === 0 },
        { v: crossing ? "Crossing" : "-", dim: !crossing },
      ],
      detail: {
        title: f.name,
        rows: [
          ...f.params.map((p) => ({ label: p.name, value: p.type, mono: true })),
          ...(f.results.length ? [{ label: "Returns", value: f.results.join(", "), mono: true }] : []),
        ],
      },
    };
  });

  // Every file's name; the text of the one shown first only (see SourceView).
  const ordered = [...(sources ?? [])].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  const firstFile = ordered.find((f) => f.name === file)?.name ?? ordered[0]?.name;
  const shownFiles = ordered.map((f) => (f.name === firstFile ? f : { name: f.name }));

  const sections = [
    {
      key: "overview",
      label: "Overview",
      content: (
        <div className="flex h-full flex-col gap-3 overflow-y-auto">
          <div className="brick-fill grid shrink-0 grid-cols-3 gap-1.5 sm:gap-2 lg:grid-cols-6">
            <BrickBoard accent={accent} bricks={bricks} bare />
            {calls ? (
              <Suspense fallback={<BrickLoading count={1} />}>
                <CallsBrick calls={calls} accent={accent} />
              </Suspense>
            ) : null}
            <BrickBoard accent={accent} bricks={deployedBrick} bare />
          </div>
          {profile}
        </div>
      ),
    },
    {
      key: "source",
      label: `Source${pkg ? ` (${pkg.files.length})` : ""}`,
      content: sources ? (
        <SourceView
          chainId={chainId}
          path={path}
          files={shownFiles}
          initial={firstFile}
        />
      ) : (
        <p className="text-sm text-muted-foreground">N/A</p>
      ),
    },
    {
      key: "functions",
      label: `Functions${funcs ? ` (${funcs.length})` : ""}`,
      content: (
        <RowDeck
          accent={accent}
          columns={[
            { label: "Function", width: "22%", phoneWidth: "40%" },
            { label: "Parameters" },
            { label: "Returns", width: "18%", optional: true },
            { label: "Kind", width: "10%", phoneHide: true },
          ]}
          rows={funcDeck}
          filter={{ placeholder: "Filter functions…" }}
          empty={funcs ? "None" : "N/A"}
        />
      ),
    },
    ...(realm
      ? [
          {
            key: "render",
            label: "Render",
            content: (
              <div className="gata-surface h-full overflow-y-auto px-4 py-3.5">
                {arg ? (
                  <p className="mb-3 font-mono text-[11.5px] text-muted-foreground">
                    {shortPath(path)}:{arg}
                  </p>
                ) : null}
                {rendered ? <Prose text={rendered} gnoChain={chainId} /> : <p className="text-sm text-muted-foreground">N/A</p>}
              </div>
            ),
          },
          {
            key: "calls",
            label: "Calls",
            content: (
              <Suspense fallback={<LoadingPanel label="Loading calls…" rows={8} />}>
                <CallsDeck calls={calls!} chain={chain} path={path} accent={accent} />
              </Suspense>
            ),
          },
        ]
      : []),
  ];

  return (
    <PageFrame
      title={shortPath(path)}
      sub={chain.prettyName}
      accent={accent}
      actions={
        <span className="rounded-full bg-[var(--gata-faint)]/15 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {realm ? "Realm" : "Package"}
        </span>
      }
    >
      <SectionTabs
        sections={sections}
        initial={arg ? "render" : file ? "source" : tab && TABS.includes(tab) ? tab : undefined}
        param="tab"
      />
    </PageFrame>
  );
}

type Calls = ReturnType<typeof gnoRealmCalls>;

function callsBrick(calls: Awaited<Calls>): BrickSpec {
  return {
    key: "calls",
    label: "Calls",
    value: calls ? calls.total.toLocaleString() : "N/A",
    sub: calls ? `from ${calls.callers.toLocaleString()} account${calls.callers === 1 ? "" : "s"}` : undefined,
  };
}

async function CallsBrick({ calls, accent }: { calls: Calls; accent: string }) {
  return <BrickBoard accent={accent} bricks={[callsBrick(await calls)]} bare />;
}

async function CallsDeck({
  calls: pending,
  chain,
  path,
  accent,
}: {
  calls: Calls;
  chain: ChainConfig;
  path: string;
  accent: string;
}) {
  const chainId = chain.chainId;
  const [calls, names] = await Promise.all([pending, withinBudget(gnoNames(chain), 1500, null)]);
  if (!calls) return <RowDeck accent={accent} columns={CALL_COLUMNS} rows={[]} empty="N/A" />;
  // The newest page; older ones come from the API, a page at a time. Read from
  // our index, the page comes with its keyset cursor (`next`); from the
  // tx-indexer, the next page starts below the last block shown.
  const first = calls.next !== undefined ? calls.calls : callsPage(calls.calls);
  const last = first.at(-1);
  const initialNext =
    calls.next !== undefined ? calls.next : calls.total > first.length && last ? String(last.height) : null;
  return (
    <OlderDeck
      endpoint={`/api/chains/${chainId}/packages/calls?path=${encodeURIComponent(path)}`}
      columns={CALL_COLUMNS}
      initialRows={callRows(chainId, first, names)}
      initialNext={initialNext}
      accent={accent}
      empty="None"
      filter={{ placeholder: "Filter by function or caller…" }}
    />
  );
}

/** Code first, then the module file, then tests. */
function rank(name: string): number {
  if (/_(test|filetest)\.gno$/.test(name)) return 2;
  if (name.endsWith(".gno")) return 0;
  return 1;
}
