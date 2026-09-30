import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getChain, symbolFor, accentFor, chainDenoms } from "@/lib/chains";
import { formatCoins } from "@/lib/coin";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { formatDateTime, timeAgo, truncateMiddle } from "@/lib/format";
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
 * The header hashes - app, data, validators - are the clearest argument for
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
  const [block, head] = await Promise.all([
    adapter.getBlockDetail(height),
    // Only to know whether there is a next block to link to.
    adapter
      .getRecentBlocks(1)
      .then((b) => (b[0] ? Number(b[0].height) : null))
      .catch(() => null),
  ]);
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);

  // Above the head, or pruned from every node we read: a real 404.
  if (!block) notFound();

  const txs = await adapter.getBlockTxs(block);
  const heightNum = Number(block.height);
  const denoms = chainDenoms(chain);

  // Cosmos blocks carry no gas totals of their own; they are the sum of their
  // transactions', and only when every transaction in the block was read.
  const complete = txs.length === block.txCount && txs.every((t) => t.code !== null);
  let gasUsed = block.gasUsed ?? null;
  let gasWanted = block.gasWanted ?? null;
  let totalFees = block.totalFees ?? null;
  if (!gasUsed && complete && txs.length > 0) {
    gasUsed = String(txs.reduce((a, t) => a + Number(t.gasUsed ?? 0), 0));
    gasWanted = String(txs.reduce((a, t) => a + Number(t.gasWanted ?? 0), 0));
    totalFees = String(
      txs.reduce(
        (a, t) =>
          a + t.fee.filter((c) => c.denom === chain.denom).reduce((x, c) => x + BigInt(c.amount), BigInt(0)),
        BigInt(0)
      )
    );
  }
  const gasPct =
    gasUsed && gasWanted && Number(gasWanted) > 0
      ? (Number(gasUsed) / Number(gasWanted)) * 100
      : null;

  const proposerName =
    block.proposerMoniker ?? block.proposerLabel ?? truncateMiddle(block.proposer, 8, 6);
  // gno lists validators under their signing address, which is the proposer.
  const proposerOperator =
    block.proposerOperator ??
    (chain.kind === "gno" && /^g1[0-9a-z]+$/.test(block.proposer) ? block.proposer : null);
  const proposerId = block.proposerValcons ?? (chain.kind === "gno" ? block.proposer : null);

  const listedAll = txs.length >= block.txCount;

  const bricks: BrickSpec[] = [
    {
      key: "time",
      label: "Produced",
      value: timeAgo(block.time),
      sub: formatDateTime(block.time),
      lead: true,
    },
    {
      key: "proposer",
      label: "Proposer",
      value: proposerName,
      sub: proposerId ? truncateMiddle(proposerId, 12, 6) : undefined,
      text: true,
      ...(proposerOperator ? { href: `/${chainId}/validators/${proposerOperator}` } : {}),
    },
    ...(block.signatureCount != null
      ? [
          {
            key: "signatures",
            label: "Signed previous",
            value: `${block.signedCount ?? block.signatureCount} of ${block.signatureCount}`,
            sub: block.absentCount ? `${block.absentCount} absent` : "none absent",
            tone: block.absentCount ? ("bad" as const) : undefined,
            ...(block.absentCount && block.absentValidators && block.absentValidators.length > 0
              ? {
                  count: block.absentValidators.length,
                  rows: block.absentValidators.map((v) => ({
                    label: "Absent",
                    value: v.moniker,
                    href: `/${chainId}/validators/${v.operator}`,
                  })),
                }
              : {}),
          },
        ]
      : []),
    {
      key: "txs",
      label: "Transactions",
      value: String(block.txCount),
      sub: !listedAll
        ? `${txs.length} listed, N/A`
        : totalFees && totalFees !== "0"
          ? `${formatToken(totalFees, chain.exponent, 6)} ${symbol} in fees`
          : "in this block",
      tone: !listedAll ? ("bad" as const) : undefined,
    },
    ...(gasPct !== null
      ? [
          {
            key: "gas",
            label: "Gas",
            value: `${gasPct.toFixed(1)}%`,
            sub: `${Number(gasUsed).toLocaleString()} of ${Number(gasWanted).toLocaleString()}`,
            tone: gasPct > 90 ? ("bad" as const) : undefined,
          },
        ]
      : []),
    {
      key: "hashes",
      label: "Hashes",
      value: block.hash ? truncateMiddle(block.hash, 6, 4) : "-",
      sub: "block, app, data",
      rows: [
        ...(block.hash ? [{ label: "Block", value: block.hash, mono: true }] : []),
        ...(block.appHash ? [{ label: "App", value: block.appHash, mono: true }] : []),
        ...(block.dataHash ? [{ label: "Data", value: block.dataHash, mono: true }] : []),
        ...(block.validatorsHash
          ? [{ label: "Validators", value: block.validatorsHash, mono: true }]
          : []),
        { label: "Chain", value: block.chainId ?? chain.chainId, mono: true },
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
          v: `${tx.messages[0]?.label ?? "-"}${
            tx.messages.length > 1 ? ` +${tx.messages.length - 1}` : ""
          }`,
        },
        {
          v: tx.code === null ? "N/A" : ok ? "ok" : `fail ${tx.code}`,
          mono: true,
          tone: tx.code === null ? undefined : ok ? "ok" : "bad",
          dim: tx.code === null,
        },
        { v: formatCoins(tx.fee, denoms), mono: true, dim: true, align: "right" },
      ],
      detail: {
        title: truncateMiddle(tx.hash, 12, 8),
        rows: [],
        action: {
          label: "Transaction",
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
  const atHead = head !== null && heightNum >= head;

  return (
    <PageFrame
      title={`#${heightNum.toLocaleString()}`}
      sub={`${chain.prettyName} · ${timeAgo(block.time)}`}
      accent={accent}
      actions={
        <>
          {heightNum > 1 ? step(heightNum - 1, "Previous block", ChevronLeft) : null}
          {atHead ? null : step(heightNum + 1, "Next block", ChevronRight)}
        </>
      }
    >
      {/* Phones scroll the page body and give the list a fixed height; from
          lg the list takes the rest of the frame and only it scrolls. */}
      <div className="flex h-full flex-col gap-3 overflow-y-auto lg:overflow-hidden">
        <div className="shrink-0">
          <BrickBoard chainId={chainId} accent={accent} bricks={bricks} />
        </div>
        <div className="h-[32rem] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
          <RowDeck
            accent={accent}
            columns={[
              { label: "Hash", width: "26%" },
              { label: "Type" },
              { label: "Status", width: "16%" },
              { label: "Fee", align: "right", width: "20%", phoneHide: true },
            ]}
            rows={rows}
            empty={listedAll ? "No transactions in this block." : "N/A"}
          />
        </div>
      </div>
    </PageFrame>
  );
}
