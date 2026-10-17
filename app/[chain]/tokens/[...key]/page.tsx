import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { findSummary, tokenHoldersPage, tokenList, tokenTransfersPage } from "@/lib/gno-token-data";
import { OlderDeck } from "@/components/older-deck";
import { HOLDER_COLUMNS, holderRows, TRANSFER_COLUMNS, transferRows } from "../rows";
import { gnoTxTimes, packageHref, realmByAddress, shortPath } from "@/lib/gno-packages";
import { gnoNames } from "@/lib/gno-users";
import { withinBudget } from "@/lib/cache";
import { formatToken } from "@/lib/overview";
import { decodeParam, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck } from "@/components/row-deck";
import { DetailRow } from "@/components/detail-row";

export const dynamic = "force-dynamic";

/** The URL's segments: the realm path (gno.land/ optional), then the symbol. */
function keyOf(segments: string[]): { realm: string; symbol: string } | null {
  const parts = segments.map(decodeParam);
  if (parts[0] === "gno.land") parts.shift();
  if (parts.length < 3 || parts[0] !== "r") return null;
  const symbol = parts.pop()!;
  return { realm: `gno.land/${parts.join("/").toLowerCase()}`, symbol };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; key: string[] }>;
}): Promise<Metadata> {
  const { chain: chainId, key } = await params;
  const chain = getChain(chainId);
  const k = keyOf(key);
  return { title: k && chain ? `${k.symbol} on ${chain.prettyName}` : "Token" };
}

const TABS = ["overview", "holders", "transfers"];

/** One GRC20 token: its supply, who holds it, and its latest transfers. */
export default async function TokenPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string; key: string[] }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { chain: chainId, key } = await params;
  const { tab } = await searchParams;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") notFound();
  const k = keyOf(key);
  if (!k) notFound();
  const accent = accentFor(chain);

  const [tokens, names, realms] = await Promise.all([
    withinBudget(tokenList(chain), 20_000, null),
    withinBudget(gnoNames(chain), 1500, null),
    withinBudget(realmByAddress(chain), 1500, null),
  ]);
  const token = tokens ? findSummary(tokens, k.realm, k.symbol) : null;
  if (tokens && !token) notFound();

  // The first page of each list; older ones come from the API by keyset.
  const [holderPage, transferPage] = token
    ? await Promise.all([tokenHoldersPage(chain, token.key), tokenTransfersPage(chain, token.key)])
    : [null, null];
  const holders = holderPage?.holders ?? [];
  const count = token ? token.holders : 0;
  const times = transferPage
    ? await withinBudget(
        gnoTxTimes(chainId, [...new Set(transferPage.transfers.map((t) => t.txHash))]),
        2000,
        new Map<string, string>()
      )
    : new Map<string, string>();
  const amount = (v: bigint) => (token ? formatToken(v.toString(), token.decimals) : "-");
  const top10 = holders.slice(0, 10).reduce((s, h) => s + h.balance, BigInt(0));
  const share = (part: bigint) =>
    token && token.supply > BigInt(0) ? `${(Number((part * BigInt(1_000_000)) / token.supply) / 10_000).toFixed(2)}%` : "-";

  const bricks: BrickSpec[] = [
    {
      key: "supply",
      label: "Supply",
      value: token ? amount(token.supply) : "N/A",
      sub: token?.symbol,
      lead: true,
    },
    { key: "holders", label: "Holders", value: token ? count.toLocaleString() : "N/A", sub: "with a balance" },
    { key: "transfers", label: "Transfers", value: token ? token.transfers.toLocaleString() : "N/A", sub: "all time" },
    { key: "top10", label: "Top 10", value: token ? share(top10) : "N/A", sub: "of the supply" },
    { key: "decimals", label: "Decimals", value: token ? String(token.decimals) : "N/A", sub: "places" },
    {
      key: "created",
      label: "Created",
      value: token ? (token.createdHeight === 0 ? "Genesis" : token.createdHeight.toLocaleString()) : "N/A",
      sub: "block",
    },
  ];

  const profile = token ? (
    <div className="gata-surface flex shrink-0 flex-col gap-1.5 px-4 py-3.5">
      <h2 className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Token</h2>
      <div className="flex flex-col divide-y divide-border/50">
        <DetailRow label="Realm" copy={token.realm}>
          <Link href={packageHref(chainId, token.realm)} className="font-mono text-primary hover:underline">
            {token.realm}
          </Link>
        </DetailRow>
        <DetailRow label="Key" copy={token.key}>
          <span className="font-mono">{token.key}</span>
        </DetailRow>
        {token.createdTx ? (
          <DetailRow label="Created in" copy={token.createdTx}>
            <Link href={`/${chainId}/txs/${token.createdTx}`} className="font-mono text-primary hover:underline">
              {truncateMiddle(token.createdTx, 10, 8)}
            </Link>
          </DetailRow>
        ) : null}
      </div>
    </div>
  ) : null;

  const sections = [
    {
      key: "overview",
      label: "Overview",
      content: (
        <div className="flex h-full flex-col gap-3 overflow-y-auto">
          <div className="brick-fill grid shrink-0 grid-cols-3 gap-1.5 sm:gap-2 lg:grid-cols-6">
            <BrickBoard accent={accent} bricks={bricks} bare />
          </div>
          {profile}
        </div>
      ),
    },
    {
      key: "holders",
      label: `Holders${token ? ` (${count.toLocaleString()})` : ""}`,
      content: token ? (
        <OlderDeck
          endpoint={`/api/chains/${chainId}/tokens/holders?token=${encodeURIComponent(token.key)}`}
          columns={HOLDER_COLUMNS}
          initialRows={holderPage ? holderRows(chainId, token, holderPage.holders, names, realms) : []}
          initialNext={holderPage?.next ?? null}
          accent={accent}
          empty={holderPage ? "None" : "N/A"}
          filter={{ placeholder: "Filter by address…" }}
        />
      ) : (
        <RowDeck accent={accent} columns={HOLDER_COLUMNS} rows={[]} empty="N/A" />
      ),
    },
    {
      key: "transfers",
      label: "Transfers",
      content: token ? (
        <OlderDeck
          endpoint={`/api/chains/${chainId}/tokens/transfers?token=${encodeURIComponent(token.key)}`}
          columns={TRANSFER_COLUMNS}
          initialRows={transferPage ? transferRows(chainId, token, transferPage.transfers, names, realms, times) : []}
          initialNext={transferPage?.next ?? null}
          accent={accent}
          empty={transferPage ? "None" : "N/A"}
          filter={{ placeholder: "Filter by address…" }}
        />
      ) : (
        <RowDeck accent={accent} columns={TRANSFER_COLUMNS} rows={[]} empty="N/A" />
      ),
    },
  ];

  return (
    <PageFrame
      title={token?.name ?? k.symbol}
      sub={`${token?.symbol ?? k.symbol} · ${shortPath(k.realm)} · ${chain.prettyName}`}
      accent={accent}
      actions={
        <span className="rounded-full bg-[var(--gata-faint)]/15 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          GRC20
        </span>
      }
    >
      <SectionTabs sections={sections} initial={tab && TABS.includes(tab) ? tab : undefined} param="tab" />
    </PageFrame>
  );
}
