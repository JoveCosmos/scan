import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, accentFor, chainDenoms } from "@/lib/chains";
import { formatCoins } from "@/lib/coin";
import { getAdapter } from "@/lib/adapter";
import { decodeParam, timeAgo, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { RowDeck, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; hash: string }>;
}): Promise<Metadata> {
  const { hash } = await params;
  return { title: `Tx ${truncateMiddle(decodeParam(hash), 8, 6)}` };
}

/**
 * One transaction: whether it landed, what it moved, and every message in it.
 *
 * The raw log is a brick rather than a section. It is the last thing anyone
 * needs and the longest thing on the page — as a block of text at the bottom it
 * pushed the messages, which are what people actually came for, off the screen.
 */
export default async function TxDetailPage({
  params,
}: {
  params: Promise<{ chain: string; hash: string }>;
}) {
  const { chain: chainId, hash: rawHash } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const hash = decodeParam(rawHash);
  const tx = await getAdapter(chain).getTx(hash);
  const accent = accentFor(chain);
  const denoms = chainDenoms(chain);

  if (!tx) {
    return (
      <PageFrame title="Transaction not found" sub={chain.prettyName} accent={accent}>
        <p className="text-sm text-muted-foreground">
          No transaction {truncateMiddle(hash, 10, 6)} on {chain.prettyName}. It may
          be pending, or dropped from the nodes we query.{" "}
          <Link href={`/${chainId}/txs`} className="text-primary hover:underline">
            Back to transactions
          </Link>
          .
        </p>
      </PageFrame>
    );
  }

  const ok = tx.code === 0;
  const gasPct =
    tx.gasUsed && tx.gasWanted && Number(tx.gasWanted) > 0
      ? (Number(tx.gasUsed) / Number(tx.gasWanted)) * 100
      : null;

  const bricks: BrickSpec[] = [
    {
      key: "status",
      label: "Status",
      value: tx.code === null ? "unindexed" : ok ? "success" : "failed",
      sub: tx.code !== null && !ok ? `code ${tx.code}` : timeAgo(tx.time),
      tone: tx.code === null ? undefined : ok ? "ok" : "bad",
      rows: [
        { label: "Hash", value: tx.hash, mono: true },
        {
          label: "Result",
          value: tx.code === null ? "Unindexed" : ok ? "Success" : `Failed (code ${tx.code})`,
        },
        ...(tx.time ? [{ label: "Time", value: tx.time, mono: true }] : []),
        ...(tx.timeoutHeight && tx.timeoutHeight !== "0"
          ? [{ label: "Timeout height", value: tx.timeoutHeight, mono: true }]
          : []),
      ],
    },
    {
      key: "height",
      label: "Height",
      value: Number(tx.height).toLocaleString(),
      sub: timeAgo(tx.time),
      lead: true,
      href: `/${chainId}/blocks/${tx.height}`,
    },
    {
      key: "fee",
      label: "Fee",
      value: formatCoins(tx.fee, denoms, 4),
      sub: gasPct !== null ? `${gasPct.toFixed(1)}% of gas` : undefined,
      rows: [
        { label: "Fee", value: formatCoins(tx.fee, denoms), mono: true },
        ...(tx.gasUsed
          ? [{ label: "Gas used", value: Number(tx.gasUsed).toLocaleString(), mono: true }]
          : []),
        ...(tx.gasWanted
          ? [
              {
                label: "Gas wanted",
                value: Number(tx.gasWanted).toLocaleString(),
                mono: true,
              },
            ]
          : []),
        ...(gasPct !== null
          ? [{ label: "Used", value: `${gasPct.toFixed(2)}%`, mono: true }]
          : []),
      ],
    },
    {
      key: "messages",
      label: "Messages",
      value: String(tx.messageCount),
      sub: tx.messages[0]?.label,
      ...(tx.signers && tx.signers.length > 0
        ? {
            rows: [
              { label: "Messages", value: String(tx.messageCount), mono: true },
              {
                label: tx.signers.length === 1 ? "Signer" : "Signers",
                value: tx.signers.join(", "),
                mono: true,
              },
            ],
          }
        : {}),
    },
    ...(tx.memo
      ? [
          {
            key: "memo",
            label: "Memo",
            value: tx.memo,
            text: true,
            sub: "attached to this transaction",
            rows: [{ label: "Memo", value: tx.memo }],
          },
        ]
      : []),
    ...(tx.rawLog && !ok
      ? [
          {
            key: "log",
            label: "Error log",
            value: "raw log",
            sub: "why it failed",
            tone: "bad" as const,
            rows: [{ label: "Log", value: tx.rawLog, mono: true }],
          },
        ]
      : []),
  ];

  const rows: DeckRow[] = tx.messages.map((message, i) => ({
    key: `${i}-${message.typeUrl}`,
    cells: [
      { v: String(i + 1), dim: true, align: "right" },
      { v: message.label },
      {
        v: message.transfer?.from ? truncateMiddle(message.transfer.from, 10, 5) : "—",
        mono: true,
        dim: !message.transfer?.from,
      },
      {
        v: message.transfer?.to ? truncateMiddle(message.transfer.to, 10, 5) : "—",
        mono: true,
        dim: !message.transfer?.to,
      },
      {
        v:
          message.transfer && message.transfer.amount.length > 0
            ? formatCoins(message.transfer.amount, denoms, 2)
            : "—",
        mono: true,
        align: "right",
      },
    ],
    detail: {
      title: message.label,
      sub: `Message ${i + 1} of ${tx.messageCount}`,
      rows: [
        { label: "Type", value: message.typeUrl, mono: true },
        ...(message.transfer?.from
          ? [
              {
                label: message.transfer.staking ? "Delegator" : "From",
                value: message.transfer.from,
                mono: true,
                href: `/${chainId}/accounts/${message.transfer.from}`,
              },
            ]
          : []),
        ...(message.transfer?.to
          ? [
              {
                label: message.transfer.staking ? "Validator" : "To",
                value: message.transfer.to,
                mono: true,
                href: message.transfer.to.includes("valoper")
                  ? `/${chainId}/validators/${message.transfer.to}`
                  : `/${chainId}/accounts/${message.transfer.to}`,
              },
            ]
          : []),
        ...(message.transfer && message.transfer.amount.length > 0
          ? [
              {
                label: "Amount",
                value: formatCoins(message.transfer.amount, denoms),
                mono: true,
              },
            ]
          : []),
      ],
    },
  }));

  return (
    <PageFrame
      title={truncateMiddle(tx.hash, 12, 8)}
      sub={`${chain.prettyName} · ${tx.code === null ? "unindexed" : ok ? "success" : "failed"}`}
      accent={accent}
    >
      <div className="flex h-full flex-col gap-3">
        <div className="shrink-0">
          <BrickBoard chainId={chainId} accent={accent} bricks={bricks} />
        </div>
        <div className="min-h-0 flex-1">
          <RowDeck
            accent={accent}
            columns={[
              { label: "#", align: "right", width: "8%" },
              { label: "Type" },
              { label: "From", phoneHide: true, width: "20%" },
              { label: "To", phoneHide: true, width: "20%" },
              { label: "Amount", align: "right", width: "22%" },
            ]}
            rows={rows}
            empty="No messages decoded."
          />
        </div>
      </div>
    </PageFrame>
  );
}
