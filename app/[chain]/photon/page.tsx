import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor, symbolFor } from "@/lib/chains";
import { getPhotonHistory, getPhotonState, type PhotonHistory } from "@/lib/photon";
import { withinBudget } from "@/lib/cache";
import { formatToken } from "@/lib/overview";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { PairPanels } from "@/components/pair-panels";
import { RowDeck, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} PHOTON` : "PHOTON" };
}

const PHOTON_EXPONENT = 6;

/** Share of `part` in `whole`, both base-unit strings, as a percentage string. */
function pctOf(part: string | null, whole: number | string | null): string | null {
  if (!part || whole === null) return null;
  const w = typeof whole === "number" ? whole : Number(whole);
  if (!(w > 0)) return null;
  return `${((Number(part) / w) * 100).toFixed(2)}%`;
}

/**
 * AtomOne's fee token: how much PHOTON exists against its cap, what one ATONE
 * mints now, how much ATONE has been burned to mint it, and who mints.
 */
export default async function PhotonPage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || !chain.photon) notFound();
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);

  const [state, history] = await Promise.all([
    withinBudget(getPhotonState(chain), 3000, null),
    withinBudget(getPhotonHistory(chain), 8000, null),
  ]);

  // The cap is configured in whole PHOTON; supply is in base units.
  const capBase = chain.feeSupplyCap ? chain.feeSupplyCap * 10 ** PHOTON_EXPONENT : null;
  const photon = (v: string | null) => (v ? formatToken(v, PHOTON_EXPONENT) : "N/A");
  const atone = (v: string | null) => (v ? formatToken(v, chain.exponent) : "N/A");

  const bricks: BrickSpec[] = [
    {
      key: "supply",
      label: "PHOTON supply",
      value: photon(state?.photonSupply ?? null),
      sub: pctOf(state?.photonSupply ?? null, capBase) ? `${pctOf(state!.photonSupply, capBase)} of the cap` : "PHOTON",
      lead: true,
    },
    {
      key: "rate",
      label: "Mint rate",
      value: state?.rate != null ? state.rate.toFixed(4) : "N/A",
      sub: `PHOTON per ${symbol}`,
    },
    {
      key: "burned",
      label: `${symbol} burned`,
      value: atone(history?.burned ?? null),
      sub: history ? `in ${history.mints.toLocaleString()} mints` : undefined,
    },
    {
      key: "minters",
      label: "Minters",
      value: history ? history.minters.toLocaleString() : "N/A",
      sub: "accounts",
    },
    {
      key: "status",
      label: "Minting",
      value: state?.mintDisabled == null ? "N/A" : state.mintDisabled ? "Disabled" : "Open",
      tone: state?.mintDisabled === false ? "ok" : state?.mintDisabled ? "bad" : undefined,
      sub: chain.feeSupplyCap ? `cap ${chain.feeSupplyCap.toLocaleString()}` : undefined,
    },
  ];

  const recentRows: DeckRow[] = (history?.recent ?? []).map((m) => ({
    key: `${m.txHash}-${m.minter}`,
    cells: [
      { v: truncateMiddle(m.minter, 10, 6), address: m.minter, mono: true },
      { v: `${atone(m.burned)} ${symbol}`, mono: true, align: "right" },
      { v: m.minted ? `${photon(m.minted)} PHOTON` : "-", mono: true, align: "right", dim: !m.minted },
      { v: timeAgo(m.time), dim: true, align: "right" },
    ],
    detail: { title: "Mint", rows: [], action: { label: "Transaction", href: `/${chainId}/txs/${m.txHash}` } },
  }));

  const topRows: DeckRow[] = (history?.top ?? []).map((t, i) => ({
    key: t.minter,
    cells: [
      { v: String(i + 1), mono: true, dim: true, align: "right" },
      { v: truncateMiddle(t.minter, 10, 6), address: t.minter, mono: true },
      { v: `${atone(t.burned)} ${symbol}`, mono: true, align: "right" },
      { v: t.mints.toLocaleString(), mono: true, align: "right" },
    ],
    detail: { title: truncateMiddle(t.minter, 14, 8), rows: [], action: { label: "Account", href: `/${chainId}/accounts/${t.minter}` } },
  }));

  const facts = [
    ...(state?.photonSupply ? [`${photon(state.photonSupply)} PHOTON`] : []),
    ...(state?.rate != null ? [`1 ${symbol} = ${state.rate.toFixed(2)} PHOTON`] : []),
    ...(history ? [`${atone(history.burned)} ${symbol} burned`] : []),
  ];

  return (
    <PageFrame title="PHOTON" sub={facts.length ? facts.join(" · ") : chain.prettyName} accent={accent}>
      <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto pb-3 sm:gap-3 lg:overflow-hidden lg:pb-0">
        <div className="brick-dense shrink-0">
          <BrickBoard accent={accent} bricks={bricks} size="lg" />
        </div>
        {history && history.daily.length > 0 ? (
          <BurnChart daily={history.daily} exponent={chain.exponent} symbol={symbol} accent={accent} />
        ) : null}
        <div className="shrink-0 lg:min-h-0 lg:flex-1">
          <PairPanels
            panels={[
              {
                key: "recent",
                label: "Recent mints",
                content: (
                  <RowDeck
                    accent={accent}
                    columns={[
                      { label: "Minter" },
                      { label: "Burned", align: "right", width: "26%" },
                      { label: "Minted", align: "right", width: "26%", phoneHide: true },
                      { label: "Age", align: "right", width: "16%" },
                    ]}
                    rows={recentRows}
                    empty={history ? "None" : "N/A"}
                  />
                ),
              },
              {
                key: "top",
                label: "Top minters",
                content: (
                  <RowDeck
                    accent={accent}
                    columns={[
                      { label: "#", align: "right", width: "10%" },
                      { label: "Minter" },
                      { label: "Burned", align: "right", width: "30%" },
                      { label: "Mints", align: "right", width: "14%", phoneHide: true },
                    ]}
                    rows={topRows}
                    empty={history ? "None" : "N/A"}
                  />
                ),
              },
            ]}
          />
        </div>
      </div>
    </PageFrame>
  );
}

/** ATONE burned per day, last 90 days: one bar a day, the scale from the largest. */
function BurnChart({
  daily,
  exponent,
  symbol,
  accent,
}: {
  daily: PhotonHistory["daily"];
  exponent: number;
  symbol: string;
  accent: string;
}) {
  // Fill the days without mints, so the bars line up with the calendar.
  const byDay = new Map(daily.map((d) => [d.day, Number(d.burned)]));
  const days: { day: string; v: number }[] = [];
  const today = new Date();
  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, v: byDay.get(key) ?? 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.v));
  const total = days.reduce((s, d) => s + d.v, 0);
  const W = 900;
  const H = 70;
  const bw = W / days.length;
  return (
    <section className="gata-surface shrink-0 px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium uppercase tracking-[0.1em]">{symbol} burned per day, 90 days</span>
        <span className="font-mono">
          {formatToken(String(total), exponent)} {symbol}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[70px] w-full" preserveAspectRatio="none" role="img" aria-label={`${symbol} burned per day over 90 days`}>
        {days.map((d, i) => {
          const h = d.v > 0 ? Math.max(1.5, (d.v / max) * (H - 2)) : 0;
          return (
            <rect key={d.day} x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1.5)} height={h} rx={1} fill={accent} opacity={0.85}>
              <title>{`${d.day}: ${formatToken(String(d.v), exponent)} ${symbol}`}</title>
            </rect>
          );
        })}
      </svg>
    </section>
  );
}
