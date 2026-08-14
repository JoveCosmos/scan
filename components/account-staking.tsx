import Link from "next/link";
import type { ChainConfig } from "@/lib/chains";
import { symbolFor } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { getAccountStaking } from "@/lib/staking";

/**
 * A validator, by name where we have one. Falls back to the operator address
 * rather than a placeholder: a validator that has dropped out of the set still
 * holds real stake, and its address is what identifies it.
 */
function ValidatorLink({
  chainId,
  address,
  moniker,
  jailed,
}: {
  chainId: string;
  address: string;
  moniker: string | null;
  jailed?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Link
        href={`/${chainId}/validators/${address}`}
        className="-my-2 inline-block truncate py-2 text-primary hover:underline"
        title={address}
      >
        {moniker ?? (
          <span className="font-mono text-xs">{truncateMiddle(address, 14, 8)}</span>
        )}
      </Link>
      {jailed ? (
        <span className="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-destructive">
          jailed
        </span>
      ) : null}
    </span>
  );
}

function Amount({
  raw,
  chain,
  symbol,
  muted,
}: {
  raw: string;
  chain: ChainConfig;
  symbol: string;
  muted?: boolean;
}) {
  return (
    <span className={muted ? "text-muted-foreground" : undefined}>
      {formatToken(raw, chain.exponent, 2)}{" "}
      <span className="text-muted-foreground">{symbol}</span>
    </span>
  );
}

/** "in 12 days", for an unbonding or redelegation that has not completed yet. */
function completesIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "any moment";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "in under an hour";
}

/**
 * What an account has at stake, per validator.
 *
 * The stat tile above gives the total; this is the part a delegator actually
 * needs — which validators hold the stake, what each is earning, and anything
 * currently unbonding or moving between validators.
 */
export async function AccountStaking({
  chain,
  address,
}: {
  chain: ChainConfig;
  address: string;
}) {
  const staking = await getAccountStaking(chain, address);
  const symbol = symbolFor(chain);

  if (staking.failed) {
    return (
      <div className="gata-panel px-5 py-7 text-center">
        <p className="text-sm text-muted-foreground">
          The staking module did not answer. Delegations are unavailable right now.
        </p>
      </div>
    );
  }

  if (
    staking.delegations.length === 0 &&
    staking.unbonding.length === 0 &&
    staking.redelegations.length === 0
  ) {
    return (
      <div className="gata-panel px-5 py-7 text-center">
        <p className="text-sm text-muted-foreground">
          This account has nothing staked.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {staking.delegations.length > 0 ? (
        <div className="gata-panel overflow-x-auto">
          <table className="gata-table w-full text-sm sm:min-w-[560px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground">Validator</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Delegated
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Reward
                </th>
              </tr>
            </thead>
            <tbody>
              {staking.delegations.map((d) => (
                <tr
                  key={d.validator}
                  className="border-b border-border/50 transition-colors last:border-0 hover:bg-[var(--gata-card-hi)]/60"
                >
                  <td data-label="Validator" data-primary className="max-w-0 px-4 py-3">
                    <ValidatorLink
                      chainId={chain.chainId}
                      address={d.validator}
                      moniker={d.moniker}
                      jailed={d.jailed}
                    />
                  </td>
                  <td
                    data-label="Delegated"
                    className="px-4 py-3 text-right font-mono tabular-nums"
                  >
                    <Amount raw={d.amount} chain={chain} symbol={symbol} />
                  </td>
                  <td
                    data-label="Reward"
                    className="px-4 py-3 text-right font-mono tabular-nums"
                  >
                    {d.reward === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Amount raw={d.reward} chain={chain} symbol={symbol} muted />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {staking.unbonding.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">Unbonding</h3>
          <div className="gata-panel overflow-x-auto">
            <table className="gata-table w-full text-sm sm:min-w-[560px]">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Validator
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Amount
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Available
                  </th>
                </tr>
              </thead>
              <tbody>
                {staking.unbonding.map((u, i) => (
                  <tr
                    key={`${u.validator}-${u.completion}-${i}`}
                    className="border-b border-border/50 last:border-0 hover:bg-[var(--gata-card-hi)]/60"
                  >
                    <td data-label="Validator" data-primary className="max-w-0 px-4 py-3">
                      <ValidatorLink
                        chainId={chain.chainId}
                        address={u.validator}
                        moniker={u.moniker}
                      />
                    </td>
                    <td
                      data-label="Amount"
                      className="px-4 py-3 text-right font-mono tabular-nums"
                    >
                      <Amount raw={u.amount} chain={chain} symbol={symbol} />
                    </td>
                    <td
                      data-label="Available"
                      className="px-4 py-3 text-right text-muted-foreground"
                    >
                      {completesIn(u.completion)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {staking.redelegations.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            Redelegating
          </h3>
          <div className="gata-panel overflow-x-auto">
            <table className="gata-table w-full text-sm sm:min-w-[560px]">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">From</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">To</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Amount
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Completes
                  </th>
                </tr>
              </thead>
              <tbody>
                {staking.redelegations.map((r, i) => (
                  <tr
                    key={`${r.from}-${r.to}-${r.completion}-${i}`}
                    className="border-b border-border/50 last:border-0 hover:bg-[var(--gata-card-hi)]/60"
                  >
                    <td data-label="From" data-primary className="max-w-0 px-4 py-3">
                      <ValidatorLink
                        chainId={chain.chainId}
                        address={r.from}
                        moniker={r.fromMoniker}
                      />
                    </td>
                    <td data-label="To" className="max-w-0 px-4 py-3">
                      <ValidatorLink
                        chainId={chain.chainId}
                        address={r.to}
                        moniker={r.toMoniker}
                      />
                    </td>
                    <td
                      data-label="Amount"
                      className="px-4 py-3 text-right font-mono tabular-nums"
                    >
                      <Amount raw={r.amount} chain={chain} symbol={symbol} />
                    </td>
                    <td
                      data-label="Completes"
                      className="px-4 py-3 text-right text-muted-foreground"
                    >
                      {completesIn(r.completion)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
