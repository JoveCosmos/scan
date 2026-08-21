import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getChain, symbolFor, accentFor, chainDenoms } from "@/lib/chains";
import { formatCoins } from "@/lib/coin";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { RowDeck, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; height: string }>;
}): Promise<Metadata> {
  const { height } = await params;
  return { title: `Block #${height}` };
}

/**
 * One block: a band of bricks over the transactions it carried.
 *
 * The header hashes — app, data, validators — are the clearest argument for
 * this layout. They are the reason someone opens a block once a year and pure
 * noise every other time, so they are one brick rather than three rows anyone
 * reading the transaction list has to scroll past.
 *
 * Both boards take plain serialisable data, so this stays a server component
 * and nothing about the block is fetched twice.
 */
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
      <PageFrame title="Block not found" sub={chain.prettyName} accent={accent}>
        <p className="text-sm text-muted-foreground">
          Height {Number(height).toLocaleString()} is unavailable on{" "}
          {chain.prettyName}. It may be above the current head, or pruned from the
          nodes we query.{" "}
          <Link href={`/${chainId}/blocks`} className="text-primary hover:underline">
            Back to blocks
          </Link>
          .
        </p>
      </PageFrame>
    );
  }

  const txs = await adapter.getBlockTxs(block);
  const heightNum = Number(block.height);
  const denoms = chainDenoms(chain);
  const gasPct =
    block.gasUsed && block.gasWanted && Number(block.gasWanted) > 0
      ? (Number(block.gasUsed) / Number(block.gasWanted)) * 100
      : null;

  const proposerName =
    block.proposerMoniker ?? block.proposerLabel ?? truncateMiddle(block.proposer, 8, 6);

  const bricks: BrickSpec[] = [
    {
      key: "time",
      label: "Produced",
      value: timeAgo(block.time),
      sub: new Date(block.time).toLocaleTimeString(),
      lead: true,
      rows: [
        { label: "Height", value: heightNum.toLocaleString(), mono: true },
        { label: "Time", value: block.time, mono: true },
        { label: "Local", value: new Date(block.time).toLocaleString() },
        { label: "Chain", value: block.chainId ?? chain.chainId, mono: true },
      ],
    },
    {
      key: "proposer",
      label: "Proposer",
      value: proposerName,
      sub: block.signatureCount != null ? `${block.signatureCount} signatures` : undefined,
      text: true,
      rows: [
        { label: "Proposer", value: proposerName },
        {
          label: "Consensus address",
          value: block.proposer,
          mono: true,
          ...(block.proposerOperator
            ? { href: `/${chainId}/validators/${block.proposerOperator}` }
            : {}),
        },
        ...(block.signatureCount != null
          ? [
              {
                label: "Signatures",
                value: String(block.signatureCount),
                mono: true,
              },
            ]
          : []),
      ],
    },
    {
      key: "txs",
      label: "Transactions",
      value: String(block.txCount),
      sub: block.totalFees
        ? `${formatToken(block.totalFees, chain.exponent, 6)} ${symbol} in fees`
        : "in this block",
    },
    ...(gasPct !== null
      ? [
          {
            key: "gas",
            label: "Gas",
            value: `${gasPct.toFixed(1)}%`,
            sub: "of wanted",
            tone: gasPct > 90 ? ("bad" as const) : undefined,
            rows: [
              {
                label: "Used",
                value: Number(block.gasUsed).toLocaleString(),
                mono: true,
              },
              {
                label: "Wanted",
                value: Number(block.gasWanted).toLocaleString(),
                mono: true,
              },
              { label: "Share", value: `${gasPct.toFixed(2)}%`, mono: true },
            ],
          },
        ]
      : []),
    {
      key: "hashes",
      label: "Hashes",
      value: block.hash ? truncateMiddle(block.hash, 6, 4) : "—",
      sub: "block, app, data",
      rows: [
        ...(block.hash ? [{ label: "Block", value: block.hash, mono: true }] : []),
        ...(block.appHash ? [{ label: "App", value: block.appHash, mono: true }] : []),
        ...(block.dataHash ? [{ label: "Data", value: block.dataHash, mono: true }] : []),
        ...(block.validatorsHash
          ? [{ label: "Validators", value: block.validatorsHash, mono: true }]
          : []),
      ],
    },
  ];

  const rows: DeckRow[] = txs.map((tx) => {
    const ok = tx.code === 0;
    return {
      key: tx.hash,
      cells: [
        { v: truncateMiddle(tx.hash, 10, 6), mono: true, tone: "accent" },
        {
          v: `${tx.messages[0]?.label ?? "—"}${
            tx.messages.length > 1 ? ` +${tx.messages.length - 1}` : ""
          }`,
        },
        {
          v: tx.code === null ? "unindexed" : ok ? "ok" : `fail ${tx.code}`,
          mono: true,
          tone: tx.code === null ? undefined : ok ? "ok" : "bad",
        },
        { v: formatCoins(tx.fee, denoms), mono: true, dim: true, align: "right" },
      ],
      detail: {
        title: truncateMiddle(tx.hash, 12, 8),
        sub: tx.messages[0]?.label,
        rows: [
          { label: "Hash", value: tx.hash, mono: true },
          {
            label: "Status",
            value: tx.code === null ? "Unindexed" : ok ? "Success" : `Failed (${tx.code})`,
          },
          { label: "Messages", value: String(tx.messageCount), mono: true },
          ...(tx.messages.length > 0
            ? [{ label: "Types", value: tx.messages.map((m) => m.label).join(", ") }]
            : []),
          { label: "Fee", value: formatCoins(tx.fee, denoms), mono: true },
          ...(tx.memo ? [{ label: "Memo", value: tx.memo }] : []),
        ],
        action: {
          label: "Full transaction",
          href: `/${chainId}/txs/${encodeURIComponent(tx.hash)}`,
        },
      },
    };
  });

  const step = (to: number, label: string, Icon: typeof ChevronLeft) => (
    <Link
      href={`/${chainId}/blocks/${to}`}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/60 px-2 py-1.5 text-xs transition-colors hover:border-[var(--gata-border-hi)]"
    >
      <Icon className="h-3.5 w-3.5" />
    </Link>
  );

  return (
    <PageFrame
      title={`#${heightNum.toLocaleString()}`}
      sub={`${chain.prettyName} · ${timeAgo(block.time)}`}
      accent={accent}
      actions={
        <>
          {heightNum > 1 ? step(heightNum - 1, "Previous block", ChevronLeft) : null}
          {step(heightNum + 1, "Next block", ChevronRight)}
        </>
      }
    >
      <div className="flex h-full flex-col gap-3">
        <div className="shrink-0">
          <BrickBoard chainId={chainId} accent={accent} bricks={bricks} />
        </div>
        <div className="min-h-0 flex-1">
          <RowDeck
            accent={accent}
            columns={[
              { label: "Hash", width: "26%" },
              { label: "Type" },
              { label: "Status", width: "16%" },
              { label: "Fee", align: "right", width: "20%", phoneHide: true },
            ]}
            rows={rows}
            empty="No transactions in this block."
          />
        </div>
      </div>
    </PageFrame>
  );
}
