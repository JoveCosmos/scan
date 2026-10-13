import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor, symbolFor } from "@/lib/chains";
import { getGovernorTable, type GovernorRow } from "@/lib/governors";
import { keybasePicture } from "@/lib/validator-logos";
import { withinBudget } from "@/lib/cache";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { GovernanceSwitch } from "@/components/governance-switch";
import { RowDeck, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} governors` : "Governors" };
}

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "-";

/**
 * AtomOne's governors, largest first: the accounts that vote for whoever hands
 * them their governance power, ranked by the stake behind them.
 */
export default async function GovernorsPage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || !chain.governors) notFound();
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);

  let rows: GovernorRow[] | null = null;
  try {
    rows = await getGovernorTable(chain);
  } catch {
    rows = null;
  }

  // Keybase pictures, as for validators: cached a week, never waited on long.
  const logos = new Map(
    await Promise.all(
      (rows ?? []).map(
        async (g) => [g.address, await withinBudget(keybasePicture(g.identity), 1200, null)] as const
      )
    )
  );

  const total = (rows ?? []).filter((g) => g.active).reduce((s, g) => s + g.tokens, BigInt(0));
  const top = (rows ?? []).reduce((m, g) => (g.tokens > m ? g.tokens : m), BigInt(0));
  const share = (t: bigint) => (total > BigInt(0) ? Number((t * BigInt(1_000_000)) / total) / 1_000_000 : 0);
  const active = (rows ?? []).filter((g) => g.active).length;

  const deck: DeckRow[] = (rows ?? []).map((g, i) => {
    const pic = logos.get(g.address);
    return {
      key: g.address,
      search: `${g.moniker} ${g.address} ${g.account ?? ""}`,
      cells: [
        { v: String(i + 1), mono: true, dim: true, align: "right" },
        {
          v: g.moniker,
          avatar: { name: g.moniker, logos: pic ? [pic] : [] },
        },
        {
          v: `${formatToken(g.tokens.toString(), chain.exponent)} ${symbol}`,
          mono: true,
          align: "right",
          bar: top > BigInt(0) ? Number((g.tokens * BigInt(1000)) / top) / 1000 : 0,
        },
        {
          v: g.active ? `${(share(g.tokens) * 100).toFixed(2)}%` : "-",
          mono: true,
          align: "right",
          dim: !g.active,
        },
        { v: g.delegators.toLocaleString(), mono: true, align: "right" },
        { v: g.active ? "Active" : "Inactive", tone: g.active ? "ok" : undefined, dim: !g.active },
        { v: day(g.statusSince), dim: true, align: "right" },
      ],
      detail: {
        title: g.moniker,
        sub: truncateMiddle(g.address, 14, 8),
        rows: [],
        action: { label: "Governor", href: `/${chain.chainId}/governors/${g.address}` },
      },
    };
  });

  const facts = rows
    ? [
        `${rows.length} governors`,
        `${active} active`,
        ...(total > BigInt(0) ? [`${formatToken(total.toString(), chain.exponent)} ${symbol} governed`] : []),
      ]
    : ["N/A"];

  return (
    <PageFrame
      title="Governors"
      sub={facts.join(" · ")}
      accent={accent}
      actions={
        <GovernanceSwitch chainId={chain.chainId} current="governors" counts={{ governors: rows?.length ?? null }} />
      }
    >
      <RowDeck
        accent={accent}
        columns={[
          { label: "#", align: "right", width: "3rem", phoneHide: true },
          { label: "Governor" },
          { label: "Voting power", align: "right", width: "20%", phoneWidth: "38%" },
          { label: "Share", align: "right", width: "8%", optional: true },
          { label: "Delegators", align: "right", width: "10%", phoneHide: true },
          { label: "Status", width: "9%", optional: true },
          { label: "Since", align: "right", width: "12%", optional: true },
        ]}
        rows={deck}
        filter={{ placeholder: "Filter by name or address…" }}
        empty={rows ? "None" : "N/A"}
      />
    </PageFrame>
  );
}
