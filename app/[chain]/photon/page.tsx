import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor, symbolFor } from "@/lib/chains";
import { getPhotonHistory, getPhotonState } from "@/lib/photon";
import { withinBudget } from "@/lib/cache";
import { formatToken } from "@/lib/overview";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { BrickBoard, type BrickSpec } from "@/components/brick-board";
import { PairPanels } from "@/components/pair-panels";
import { RowDeck, type DeckRow } from "@/components/row-deck";
import { DayBars } from "@/components/day-bars";

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
          <DayBars
            title={`${symbol} burned per day, 90 days`}
            points={history.daily.map((d) => ({ day: d.day, v: Number(d.burned) }))}
            format={(v) => `${formatToken(String(Math.round(v)), chain.exponent)} ${symbol}`}
            accent={accent}
          />
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
