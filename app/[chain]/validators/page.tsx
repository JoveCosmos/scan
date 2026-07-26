import { notFound } from "next/navigation";
import { getChain, symbolFor, accentFor } from "@/lib/chains";
import { getValidators, statusLabel } from "@/lib/validators";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";

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

export default async function ValidatorsPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const validators = await getValidators(chain);
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
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Validators</h1>
        <p className="text-sm text-muted-foreground">
          Active set on {chain.prettyName}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatPanel
          index={0}
          accent={accent}
          label="Active Validators"
          value={String(validators.length)}
        />
        <StatPanel
          index={1}
          accent={accent}
          label="Nakamoto Coefficient"
          value={nakamoto > 0 ? String(nakamoto) : "—"}
          sub="to exceed ⅓ of stake"
        />
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
      </div>

      <div className="gata-panel overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">#</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Validator</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Voting Power</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Cumulative</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Staked</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Commission</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {validators.map((v) => (
              <tr
                key={v.operatorAddress}
                className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
              >
                <td className="px-4 py-2.5 font-mono tabular-nums text-muted-foreground">
                  {v.rank}
                </td>
                <td className="max-w-[240px] px-4 py-2.5">
                  <div className="truncate font-medium" title={v.moniker}>
                    {v.moniker}
                  </div>
                  <div
                    className="truncate font-mono text-xs text-muted-foreground"
                    title={v.operatorAddress}
                  >
                    {truncateMiddle(v.operatorAddress, 14, 8)}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">
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
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                  {(v.cumulativePower * 100).toFixed(1)}%
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                  {formatToken(v.tokens, chain.exponent)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                  {(v.commissionRate * 100).toFixed(1)}%
                </td>
                <td className="px-4 py-2.5">
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
