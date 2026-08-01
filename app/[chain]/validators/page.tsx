import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, symbolFor, accentFor, type ChainConfig } from "@/lib/chains";
import { Skeleton } from "@/components/ui/skeleton";
import { statusLabel } from "@/lib/validators";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { UptimeBars } from "@/components/uptime-bars";
import { emptyUptime } from "@/lib/uptime";

export const revalidate = 60;

function StatPanel({
  label,
  value,
  sub,
  accent,
  index,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  index: number;
}) {
  return (
    <div
      className="gata-panel gata-panel-interactive gata-rise p-5"
      style={{
        ["--panel-accent" as string]: accent,
        ["--panel-glow" as string]: `${accent}1f`,
        animationDelay: `${index * 60}ms`,
      }}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-3xl font-semibold leading-none">{value}</p>
      {sub ? <p className="mt-2 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[420px] rounded-xl" />
    </div>
  );
}

/**
 * The page shell resolves synchronously so an unknown chain can still produce a
 * real 404; only the slow validator-set read streams in behind Suspense.
 */
export default async function ValidatorsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Validators</h1>
        <p className="text-sm text-muted-foreground">
          Active set on {chain.prettyName}
        </p>
      </div>

      <Suspense fallback={<TableSkeleton />}>
        <ValidatorsContent chain={chain} />
      </Suspense>
    </main>
  );
}

async function ValidatorsContent({ chain }: { chain: ChainConfig }) {
  const chainId = chain.chainId;
  const adapter = getAdapter(chain);
  const [validators, registered] = await Promise.all([
    adapter.getValidators(),
    adapter.getRegisteredCount(),
  ]);
  // Needs the validator set first: uptime is keyed by the same identifier.
  const uptime = await adapter.getUptime(validators).catch(() => new Map());
  const { staking, stakeWeighted, registry, slashingWindow } = adapter.capabilities;
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  // Smallest number of validators that together exceed 1/3 of stake — i.e. the
  // number that would have to collude to halt the chain.
  const nakamoto = validators.findIndex((v) => v.cumulativePower > 1 / 3) + 1;

  const totalBonded = validators.reduce((sum, v) => sum + Number(v.tokens), 0);
  const avgCommission =
    validators.length > 0
      ? validators.reduce((sum, v) => sum + v.commissionRate, 0) / validators.length
      : 0;

  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatPanel
          index={0}
          accent={accent}
          label="Active Validators"
          value={String(validators.length)}
          sub={
            registry && registered !== null
              ? `${registered} registered in valopers`
              : undefined
          }
        />
        <StatPanel
          index={1}
          accent={accent}
          label="Nakamoto Coefficient"
          value={nakamoto > 0 ? String(nakamoto) : "—"}
          // On a chain without staking the same figure still measures how many
          // validators must collude to halt consensus — but it is weighted by
          // assigned voting power, not by stake.
          sub={
            stakeWeighted
              ? "to exceed ⅓ of stake"
              : "to exceed ⅓ of voting power"
          }
        />
        {staking ? (
          <>
            <StatPanel
              index={2}
              accent={accent}
              label="Bonded Stake"
              value={formatToken(String(totalBonded), chain.exponent)}
              sub={symbol}
            />
            <StatPanel
              index={3}
              accent={accent}
              label="Avg Commission"
              value={`${(avgCommission * 100).toFixed(1)}%`}
            />
          </>
        ) : (
          <>
            <StatPanel
              index={2}
              accent={accent}
              label="Total Voting Power"
              value={totalBonded.toLocaleString()}
              sub="assigned, not staked"
            />
            <StatPanel
              index={3}
              accent={accent}
              label="Registered"
              value={registered !== null ? String(registered) : "—"}
              sub="valopers realm profiles"
            />
          </>
        )}
      </div>

      <div className="gata-panel overflow-x-auto">
        <table className="gata-table w-full text-sm sm:min-w-[760px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">#</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Validator</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Voting Power</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Uptime</th>
              {staking ? (
                <>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Staked</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Commission</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
                </>
              ) : (
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Power</th>
              )}
            </tr>
          </thead>
          <tbody>
            {validators.map((v) => (
              <tr
                key={v.operatorAddress}
                className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
              >
                <td data-label="Rank" className="px-4 py-2.5 font-mono tabular-nums text-muted-foreground">
                  {v.rank}
                </td>
                <td data-label="Validator" data-primary className="px-4 py-2.5 sm:max-w-[240px]">
                  {/* Cosmos links to a staking profile; gno links to its
                      valopers-realm profile, keyed by consensus address. */}
                  <Link
                    href={`/${chainId}/validators/${v.operatorAddress}`}
                    className="block min-w-0"
                  >
                    <div
                      className="truncate font-medium text-primary hover:underline"
                      title={v.moniker}
                    >
                      {v.moniker}
                    </div>
                    <div
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={v.operatorAddress}
                    >
                      {truncateMiddle(v.operatorAddress, 14, 8)}
                    </div>
                  </Link>
                </td>
                <td data-label="Voting Power" className="px-4 py-2.5 text-right">
                  <div className="font-mono tabular-nums">
                    {(v.votingPower * 100).toFixed(2)}%
                  </div>
                  <div
                    className="mt-1 ml-auto h-1 w-20 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (v.votingPower / (validators[0]?.votingPower || 1)) * 100)}%`,
                        background: accent,
                      }}
                    />
                  </div>
                </td>
                <td data-label="Uptime" className="px-4 py-2.5 text-right">
                  <UptimeBars
                    uptime={uptime.get(v.operatorAddress) ?? emptyUptime()}
                    slashingWindow={slashingWindow}
                    className="items-end"
                  />
                </td>
                {!staking ? (
                  <td data-label="Power" className="px-4 py-2.5 text-right font-mono tabular-nums">
                    {Number(v.tokens).toLocaleString()}
                  </td>
                ) : (
                  <>
                <td data-label="Staked" className="px-4 py-2.5 text-right font-mono tabular-nums">
                  {formatToken(v.tokens, chain.exponent)}
                </td>
                <td data-label="Commission" className="px-4 py-2.5 text-right font-mono tabular-nums">
                  {(v.commissionRate * 100).toFixed(1)}%
                </td>
                <td data-label="Status" className="px-4 py-2.5">
                  <span
                    className={
                      v.jailed
                        ? "rounded-full bg-[var(--gata-burn)]/12 px-2 py-0.5 text-xs text-[var(--gata-burn)]"
                        : "rounded-full bg-[var(--gata-green)]/12 px-2 py-0.5 text-xs text-[var(--gata-green)]"
                    }
                  >
                    {v.jailed ? "Jailed" : statusLabel(v.status)}
                  </span>
                </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
