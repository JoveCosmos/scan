import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { gnoTokens, holderCount, tokenHref } from "@/lib/gno-tokens";
import { shortPath } from "@/lib/gno-packages";
import { withinBudget } from "@/lib/cache";
import { formatToken } from "@/lib/overview";
import { PageFrame } from "@/components/page-frame";
import { RowDeck, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} tokens` : "Tokens" };
}

/** gno.land's GRC20 tokens, most held first. */
export default async function TokensPage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") notFound();
  const accent = accentFor(chain);

  const tokens = await withinBudget(gnoTokens(chain), 20_000, null);
  const list = [...(tokens?.values() ?? [])]
    .map((t) => ({ t, holders: holderCount(t) }))
    .sort((a, b) => b.holders - a.holders || b.t.transfers - a.t.transfers || a.t.symbol.localeCompare(b.t.symbol));
  const top = list.reduce((m, x) => Math.max(m, x.holders), 0);

  const rows: DeckRow[] = list.map(({ t, holders }, i) => ({
    key: t.key,
    search: `${t.name} ${t.symbol} ${t.realm}`,
    cells: [
      { v: String(i + 1), mono: true, dim: true, align: "right" },
      { v: t.name, avatar: { name: t.symbol || t.name, logos: [] }, href: tokenHref(chainId, t) },
      { v: t.symbol, mono: true },
      { v: shortPath(t.realm), mono: true, dim: true },
      { v: holders.toLocaleString(), mono: true, align: "right", bar: top ? holders / top : 0 },
      { v: t.transfers.toLocaleString(), mono: true, align: "right" },
      { v: formatToken(t.supply.toString(), t.decimals), mono: true, align: "right" },
    ],
    detail: { title: t.name, sub: t.symbol, rows: [], action: { label: "Token", href: tokenHref(chainId, t) } },
  }));

  const facts = tokens
    ? [`${list.length} tokens`, `${list.reduce((n, x) => n + x.t.transfers, 0).toLocaleString()} transfers`]
    : ["N/A"];

  return (
    <PageFrame title="Tokens" sub={facts.join(" · ")} accent={accent}>
      <RowDeck
        accent={accent}
        columns={[
          { label: "#", align: "right", width: "3rem", phoneHide: true },
          { label: "Token" },
          { label: "Symbol", width: "10%", phoneHide: true },
          { label: "Realm", width: "24%", optional: true },
          { label: "Holders", align: "right", width: "14%", phoneWidth: "30%" },
          { label: "Transfers", align: "right", width: "10%", optional: true },
          { label: "Supply", align: "right", width: "12%", phoneHide: true },
        ]}
        rows={rows}
        filter={{ placeholder: "Filter by name, symbol or realm…" }}
        empty={tokens ? "None" : "N/A"}
      />
    </PageFrame>
  );
}
