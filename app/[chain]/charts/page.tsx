import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor, chainDenoms } from "@/lib/chains";
import { dailyActivity } from "@/lib/stats";
import { getPhotonHistory } from "@/lib/photon";
import { withinBudget } from "@/lib/cache";
import { formatToken } from "@/lib/overview";
import { PageFrame } from "@/components/page-frame";
import { DayBars } from "@/components/day-bars";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} charts` : "Charts" };
}

/** The chain's activity per day over 90 days, from the index. */
export default async function ChartsPage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || !chain.indexed) notFound();
  const accent = accentFor(chain);

  const [daily, photon] = await Promise.all([
    withinBudget(dailyActivity(chain), 10_000, null),
    chain.photon ? withinBudget(getPhotonHistory(chain), 8000, null) : null,
  ]);

  const feeInfo = chainDenoms(chain).find((d) => d.denom === (chain.feeDenom ?? chain.denom));
  const feeExp = feeInfo?.exponent ?? chain.exponent;
  const feeSym = feeInfo?.symbol ?? "";
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  const sum = (k: "txs" | "signers") => (daily ?? []).reduce((s, d) => s + d[k], 0);
  const avg = (k: "txs" | "signers") => (daily && daily.length ? sum(k) / daily.length : 0);

  return (
    <PageFrame
      title="Charts"
      sub={daily ? `90 days · ${n(sum("txs"))} transactions · ${n(avg("signers"))} signers a day` : chain.prettyName}
      accent={accent}
    >
      <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto pb-3 sm:gap-3">
        {daily ? (
          <>
            <DayBars
              title="Transactions per day"
              points={daily.map((d) => ({ day: d.day, v: d.txs }))}
              format={n}
              accent={accent}
            />
            <DayBars
              title="Active signers per day"
              points={daily.map((d) => ({ day: d.day, v: d.signers }))}
              format={n}
              total={`${n(avg("signers"))} a day`}
              accent={accent}
            />
            <DayBars
              title={`Fees per day${feeSym ? `, ${feeSym}` : ""}`}
              points={daily.map((d) => ({ day: d.day, v: Number(d.fees) }))}
              format={(v) => `${formatToken(String(Math.round(v)), feeExp)} ${feeSym}`}
              accent={accent}
            />
            {photon ? (
              <DayBars
                title="ATONE burned for PHOTON per day"
                points={photon.daily.map((d) => ({ day: d.day, v: Number(d.burned) }))}
                format={(v) => `${formatToken(String(Math.round(v)), chain.exponent)} ATONE`}
                accent={accent}
              />
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">N/A</p>
        )}
      </div>
    </PageFrame>
  );
}
