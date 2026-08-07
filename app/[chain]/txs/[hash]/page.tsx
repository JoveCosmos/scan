import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, XCircle } from "lucide-react";
import { getChain, symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { CopyButton } from "@/components/copy-button";
import { AddressLink } from "@/components/address-link";
import { TxAmount } from "@/components/tx-amount";
import { decodeParam } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; hash: string }>;
}): Promise<Metadata> {
  const { hash } = await params;
  return { title: `Tx ${decodeParam(hash).slice(0, 10)}…` };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3.5 last:border-0 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export default async function TxDetailPage({
  params,
}: {
  params: Promise<{ chain: string; hash: string }>;
}) {
  const { chain: chainId, hash: rawHash } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const hash = decodeParam(rawHash);
  const adapter = getAdapter(chain);
  const tx = await adapter.getTx(hash);
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  if (!tx) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link
          href={`/${chainId}/txs`}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to transactions
        </Link>
        <div className="gata-panel px-6 py-14 text-center">
          <h1 className="text-lg font-semibold">Transaction not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            No transaction with this hash on {chain.prettyName}. It may be from a
            pruned height, or the node has transaction indexing disabled.
          </p>
          <p className="mt-4 break-all font-mono text-xs text-muted-foreground">
            {hash}
          </p>
        </div>
      </main>
    );
  }

  const success = tx.code === 0;
  const gasPct =
    tx.gasUsed && tx.gasWanted && Number(tx.gasWanted) > 0
      ? (Number(tx.gasUsed) / Number(tx.gasWanted)) * 100
      : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href={`/${chainId}/txs`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to transactions
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Transaction</h1>
        <span
          className={
            success
              ? "inline-flex items-center gap-1.5 rounded-full bg-[var(--gata-green)]/12 px-2.5 py-1 text-xs font-medium text-[var(--gata-green)]"
              : "inline-flex items-center gap-1.5 rounded-full bg-[var(--gata-burn)]/12 px-2.5 py-1 text-xs font-medium text-[var(--gata-burn)]"
          }
        >
          {success ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <XCircle className="h-3.5 w-3.5" />
          )}
          {success ? "Success" : `Failed · code ${tx.code}`}
        </span>
      </div>

      <div
        className="gata-panel mb-5"
        style={{ ["--panel-accent" as string]: accent }}
      >
        <dl>
          <Row label="Hash">
            <div className="flex items-start gap-2">
              <span className="min-w-0 break-all font-mono text-xs">{tx.hash}</span>
              <CopyButton value={tx.hash} label="transaction hash" />
            </div>
          </Row>
          <Row label="Height">
            <span className="font-mono">{Number(tx.height).toLocaleString()}</span>
          </Row>
          <Row label="Time">
            {tx.time ? (
              <span>
                {new Date(tx.time).toUTCString()}
                <span className="ml-2 text-muted-foreground">
                  ({new Date(tx.time).toLocaleString()})
                </span>
              </span>
            ) : (
              "—"
            )}
          </Row>
          <Row label="Fee">
            {tx.fee.length > 0
              ? tx.fee
                  .map((f) => `${formatToken(f.amount, chain.exponent, 6)} ${symbol}`)
                  .join(", ")
              : "—"}
          </Row>
          <Row label="Gas">
            {tx.gasUsed && tx.gasWanted ? (
              <div className="space-y-1.5">
                <span className="font-mono text-xs">
                  {Number(tx.gasUsed).toLocaleString()} /{" "}
                  {Number(tx.gasWanted).toLocaleString()}
                  {gasPct !== null ? (
                    <span className="ml-2 text-muted-foreground">
                      {gasPct.toFixed(1)}%
                    </span>
                  ) : null}
                </span>
                {gasPct !== null ? (
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
                ) : null}
              </div>
            ) : (
              "—"
            )}
          </Row>
          {tx.memo ? (
            <Row label="Memo">
              <span className="break-all">{tx.memo}</span>
            </Row>
          ) : null}
        </dl>
      </div>

      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Messages ({tx.messageCount})
      </h2>
      <div className="gata-panel mb-5">
        {tx.messages.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No decoded messages available.
          </p>
        ) : (
          <ol>
            {tx.messages.map((msg, i) => (
              <li
                key={`${msg.typeUrl}-${i}`}
                className="flex items-center gap-3 border-b border-border/50 px-5 py-3.5 last:border-0"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-secondary font-mono text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{msg.label}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {msg.typeUrl}
                  </span>

                  {msg.transfer && (msg.transfer.from || msg.transfer.to) ? (
                    <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <AddressLink
                        chainId={chainId}
                        address={msg.transfer.from}
                      />
                      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <AddressLink chainId={chainId} address={msg.transfer.to} />
                      {msg.transfer.amount.length > 0 ? (
                        <span className="ml-1">
                          <TxAmount
                            denom={chain.denom}
                            exponent={chain.exponent}
                            symbol={symbol}
                            transfer={msg.transfer}
                          />
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {!success && tx.rawLog ? (
        <>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Error log</h2>
          <div className="gata-panel overflow-x-auto px-5 py-4">
            <pre className="font-mono text-xs whitespace-pre-wrap text-[var(--gata-burn)]">
              {tx.rawLog}
            </pre>
          </div>
        </>
      ) : null}
    </main>
  );
}
