import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { getChain, symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; height: string }>;
}): Promise<Metadata> {
  const { height } = await params;
  return { title: `Block #${height}` };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3.5 last:border-0 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function HashRow({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  if (!value) return null;
  return (
    <Row label={label}>
      <span className="break-all font-mono text-xs text-muted-foreground">{value}</span>
    </Row>
  );
}

export default async function BlockDetailPage({
  params,
}: {
  params: Promise<{ chain: string; height: string }>;
}) {
  const { chain: chainId, height } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  if (!/^\d+$/.test(height)) notFound();

  const adapter = getAdapter(chain);
  const block = await adapter.getBlockDetail(height);
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);

  if (!block) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link
          href={`/${chainId}/blocks`}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to blocks
        </Link>
        <div className="gata-panel px-6 py-14 text-center">
          <h1 className="text-lg font-semibold">Block not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Height {Number(height).toLocaleString()} is unavailable on{" "}
            {chain.prettyName}. It may be above the current head, or pruned from
            the nodes we query.
          </p>
        </div>
      </main>
    );
  }

  const txs = await adapter.getBlockTxs(block);
  const heightNum = Number(block.height);
  const gasPct =
    block.gasUsed && block.gasWanted && Number(block.gasWanted) > 0
      ? (Number(block.gasUsed) / Number(block.gasWanted)) * 100
      : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href={`/${chainId}/blocks`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to blocks
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className="h-9 w-1 rounded-full"
            style={{ background: accent, boxShadow: `0 0 16px ${accent}` }}
          />
          <div>
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              #{heightNum.toLocaleString()}
            </h1>
            <p className="text-sm text-muted-foreground">
              {new Date(block.time).toLocaleString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {heightNum > 1 ? (
            <Link
              href={`/${chainId}/blocks/${heightNum - 1}`}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/60 px-2.5 py-1.5 text-xs transition-colors hover:border-[var(--gata-border-hi)]"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Link>
          ) : null}
          <Link
            href={`/${chainId}/blocks/${heightNum + 1}`}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/60 px-2.5 py-1.5 text-xs transition-colors hover:border-[var(--gata-border-hi)]"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <div className="gata-panel mb-5" style={{ ["--panel-accent" as string]: accent }}>
        <dl>
          <Row label="Block Hash">
            {block.hash ? (
              <div className="flex items-start gap-2">
                <span className="min-w-0 break-all font-mono text-xs">{block.hash}</span>
                <CopyButton value={block.hash} label="block hash" />
              </div>
            ) : (
              "—"
            )}
          </Row>
          <Row label="Proposer">
            {block.proposerMoniker && block.proposerOperator ? (
              <Link
                href={`/${chainId}/validators/${block.proposerOperator}`}
                className="font-medium text-primary hover:underline"
              >
                {block.proposerMoniker}
              </Link>
            ) : block.proposerLabel ? (
              <span>
                <span className="font-medium">{block.proposerLabel}</span>
                <span
                  className="ml-2 font-mono text-xs text-muted-foreground"
                  title={block.proposer}
                >
                  {truncateMiddle(block.proposer, 10, 6)}
                </span>
              </span>
            ) : (
              <span
                className="font-mono text-xs text-muted-foreground"
                title={block.proposer}
              >
                {truncateMiddle(block.proposer, 12, 8)}
              </span>
            )}
          </Row>
          <Row label="Transactions">
            <span className="font-mono">{block.txCount}</span>
          </Row>
          {block.signatureCount != null ? (
            <Row label="Signatures">
              <span className="font-mono">{block.signatureCount}</span>
            </Row>
          ) : null}
          {gasPct !== null ? (
            <Row label="Gas">
              <div className="space-y-1.5">
                <span className="font-mono text-xs">
                  {Number(block.gasUsed).toLocaleString()} /{" "}
                  {Number(block.gasWanted).toLocaleString()}
                  <span className="ml-2 text-muted-foreground">
                    {gasPct.toFixed(1)}%
                  </span>
                </span>
                <div
                  className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, gasPct)}%`,
                      background: gasPct > 90 ? "var(--gata-amber)" : accent,
                    }}
                  />
                </div>
              </div>
            </Row>
          ) : null}
          {block.totalFees ? (
            <Row label="Total Fees">
              <span className="font-mono text-xs">
                {formatToken(block.totalFees, chain.exponent, 6)} {symbol}
              </span>
            </Row>
          ) : null}
          <Row label="Chain">
            <span className="font-mono text-xs">{block.chainId ?? chain.chainId}</span>
          </Row>
          <HashRow label="App Hash" value={block.appHash} />
          <HashRow label="Data Hash" value={block.dataHash} />
          <HashRow label="Validators Hash" value={block.validatorsHash} />
        </dl>
      </div>

      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Transactions ({block.txCount})
      </h2>

      {txs.length === 0 ? (
        <div className="gata-panel px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No transactions in this block.
          </p>
        </div>
      ) : (
        <div className="gata-panel overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground">Hash</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Fee
                </th>
              </tr>
            </thead>
            <tbody>
              {txs.map((tx) => (
                <tr
                  key={tx.hash}
                  className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/${chainId}/txs/${encodeURIComponent(tx.hash)}`}
                      className="font-mono text-xs text-primary hover:underline"
                      title={tx.hash}
                    >
                      {truncateMiddle(tx.hash, 10, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {tx.messages[0]?.label ?? "—"}
                    {tx.messages.length > 1 ? (
                      <span className="ml-1 text-muted-foreground">
                        +{tx.messages.length - 1}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {tx.code === null ? (
                      <span className="text-muted-foreground">Unindexed</span>
                    ) : tx.code === 0 ? (
                      <span className="text-[var(--gata-green)]">Success</span>
                    ) : (
                      <span className="text-[var(--gata-burn)]">Failed</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {tx.fee.length > 0
                      ? `${formatToken(tx.fee[0].amount, chain.exponent, 4)} ${symbol}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
