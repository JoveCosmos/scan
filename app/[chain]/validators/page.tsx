import { notFound } from "next/navigation";
import { getChain, symbolFor } from "@/lib/chains";
import { getValidators, statusLabel } from "@/lib/validators";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { Card, CardHeader, CardDescription, CardTitle } from "@/components/ui/card";

export const revalidate = 60;

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
        <Card>
          <CardHeader className="gap-1">
            <CardDescription className="text-xs uppercase tracking-wider">
              Active Validators
            </CardDescription>
            <CardTitle className="font-mono text-3xl">{validators.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="gap-1">
            <CardDescription className="text-xs uppercase tracking-wider">
              Nakamoto Coefficient
            </CardDescription>
            <CardTitle className="font-mono text-3xl">
              {nakamoto > 0 ? nakamoto : "—"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">to exceed ⅓ of stake</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="gap-1">
            <CardDescription className="text-xs uppercase tracking-wider">
              Bonded Stake
            </CardDescription>
            <CardTitle className="font-mono text-3xl">
              {formatToken(String(totalBonded), chain.exponent)}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{symbol}</p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="gap-1">
            <CardDescription className="text-xs uppercase tracking-wider">
              Avg Commission
            </CardDescription>
            <CardTitle className="font-mono text-3xl">
              {(avgCommission * 100).toFixed(1)}%
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-medium">#</th>
              <th className="px-4 py-2.5 font-medium">Validator</th>
              <th className="px-4 py-2.5 text-right font-medium">Voting Power</th>
              <th className="px-4 py-2.5 text-right font-medium">Cumulative</th>
              <th className="px-4 py-2.5 text-right font-medium">Staked</th>
              <th className="px-4 py-2.5 text-right font-medium">Commission</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {validators.map((v) => (
              <tr
                key={v.operatorAddress}
                className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/30"
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
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${Math.min(100, (v.votingPower / (validators[0]?.votingPower || 1)) * 100)}%`,
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
                        ? "rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-600 dark:text-red-400"
                        : "rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
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
