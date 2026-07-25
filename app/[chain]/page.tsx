import { notFound } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getAllChains, getChain, type ChainConfig } from "@/lib/chains";
import { fetchLcd } from "@/lib/lcd";

export function generateStaticParams() {
  return getAllChains().map((chain) => ({ chain: chain.chainId }));
}

export const dynamicParams = true;

// An explorer always shows head-of-chain state, so never prerender this at build
// time — a public node being down must not be able to fail the build.
export const dynamic = "force-dynamic";

interface LatestBlockResponse {
  block: { header: { height: string; time: string } };
}
interface StakingPoolResponse {
  pool: { bonded_tokens: string; not_bonded_tokens: string };
}
interface ValidatorsResponse {
  pagination: { total: string };
}

async function getOverviewData(chain: ChainConfig) {
  const next = {
    revalidate: 6,
    tags: [`chain:${chain.chainId}`, `chain:${chain.chainId}:overview`],
  };

  // Each tile degrades independently: one failing module shows "—" rather than
  // taking down the whole overview.
  const [latestBlock, pool, validators] = await Promise.allSettled([
    fetchLcd<LatestBlockResponse>(chain, "/cosmos/base/tendermint/v1beta1/blocks/latest", { next }),
    fetchLcd<StakingPoolResponse>(chain, "/cosmos/staking/v1beta1/pool", { next }),
    fetchLcd<ValidatorsResponse>(chain, "/cosmos/staking/v1beta1/validators", {
      next,
      searchParams: {
        status: "BOND_STATUS_BONDED",
        "pagination.count_total": true,
        "pagination.limit": 1,
      },
    }),
  ]);

  let bondedRatio: number | null = null;
  if (pool.status === "fulfilled") {
    const bonded = Number(pool.value.pool.bonded_tokens);
    const notBonded = Number(pool.value.pool.not_bonded_tokens);
    const total = bonded + notBonded;
    if (Number.isFinite(total) && total > 0) bondedRatio = bonded / total;
  }

  return {
    height: latestBlock.status === "fulfilled" ? latestBlock.value.block.header.height : null,
    blockTime: latestBlock.status === "fulfilled" ? latestBlock.value.block.header.time : null,
    activeValidators:
      validators.status === "fulfilled" ? Number(validators.value.pagination.total) : null,
    bondedRatio,
  };
}

export default async function ChainOverviewPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const data = await getOverviewData(chain);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{chain.prettyName}</h1>
      <p className="text-sm text-muted-foreground">{chain.chainId}</p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Latest Block</CardDescription>
            <CardTitle className="text-3xl">
              {data.height ? Number(data.height).toLocaleString() : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Block Time</CardDescription>
            <CardTitle className="text-3xl">
              {data.blockTime ? new Date(data.blockTime).toLocaleTimeString() : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Active Validators</CardDescription>
            <CardTitle className="text-3xl">{data.activeValidators ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Bonded Ratio</CardDescription>
            <CardTitle className="text-3xl">
              {data.bondedRatio === null ? "—" : `${(data.bondedRatio * 100).toFixed(2)}%`}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
    </main>
  );
}
