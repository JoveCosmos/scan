import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getChain, symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { decodeParam } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";
import { LinkedAddresses } from "@/components/linked-addresses";
import { AccountTxs } from "@/components/account-txs";
import { AddressElsewhere } from "@/components/address-elsewhere";
import { LoadingPanel } from "@/components/loading-panel";
import { linkedAddresses } from "@/lib/bech32";
import { resolveIbcDenoms, type DenomTrace } from "@/lib/ibc";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ addr: string }>;
}): Promise<Metadata> {
  const { addr } = await params;
  return { title: `Account ${decodeParam(addr).slice(0, 12)}…` };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border/50 px-5 py-3.5 last:border-0 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** IBC denoms are opaque hashes until resolved through a denom trace. */
function denomLabel(
  denom: string,
  symbol: string,
  baseDenom: string,
  trace?: DenomTrace
): string {
  if (denom === baseDenom) return symbol;
  if (trace) return trace.symbol;
  if (denom.startsWith("ibc/")) return `IBC ${denom.slice(4, 10)}…`;
  return denom;
}

/**
 * Exact display amount. The stat tile above uses compact notation, so the table
 * deliberately shows the full number — abbreviating both meant a balance of
 * 999.999997B also rendered as "1000.0000B", two values for one figure.
 */
function exactAmount(raw: string, exponent: number): string {
  if (!/^\d+$/.test(raw)) return raw;

  // Balances routinely exceed Number.MAX_SAFE_INTEGER — a 999999997125000000
  // ugnot balance divided as a float rendered as ...124.9999. Split with BigInt.
  // BigInt(...) rather than 10n literals, which need an ES2020 target.
  const value = BigInt(raw);
  const base = BigInt(10) ** BigInt(exponent);
  const whole = (value / base).toLocaleString();
  const fraction = (value % base).toString().padStart(exponent, "0").replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ chain: string; addr: string }>;
}) {
  const { chain: chainId, addr: rawAddr } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const address = decodeParam(rawAddr);
  const accent = accentFor(chain);
  const symbol = symbolFor(chain);
  const account = await getAdapter(chain).getAccount(address);
  // Same key, different prefix — offered so one account can be followed across
  // chains without deriving the address by hand.
  const links = linkedAddresses(address);
  // Turns "IBC 3EF74C…" into the asset it actually is.
  const traces = await resolveIbcDenoms(
    chain,
    account.balances.map((b) => b.denom)
  );

  const primary = account.balances.find((b) => b.denom === chain.denom);
  const others = account.balances.filter((b) => b.denom !== chain.denom);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href={`/${chainId}`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to {chain.prettyName}
      </Link>

      <div className="mb-6 flex items-center gap-3">
        <span
          className="h-9 w-1 rounded-full"
          style={{ background: accent, boxShadow: `0 0 16px ${accent}` }}
        />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="truncate font-mono text-sm text-muted-foreground">{address}</p>
        </div>
        <LinkedAddresses links={links} currentChainId={chainId} />
      </div>

      {!account.exists ? (
        <>
          <div className="gata-panel px-6 py-12 text-center">
            <h2 className="text-lg font-semibold">No on-chain activity</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {chain.prettyName} has no record for this address. It may never
              have been used, or it may belong to a different network.
            </p>
          </div>
          {/* Streamed: checks the same key on every linked chain. */}
          <Suspense fallback={null}>
            <AddressElsewhere links={links} currentChainId={chainId} />
          </Suspense>
        </>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div
              className="gata-panel gata-rise p-5"
              style={{ ["--panel-accent" as string]: accent }}
            >
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Available
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold leading-none">
                {primary ? formatToken(primary.amount, chain.exponent, 2) : "0"}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{symbol}</p>
            </div>
            <div
              className="gata-panel gata-rise p-5"
              style={{
                ["--panel-accent" as string]: accent,
                animationDelay: "60ms",
              }}
            >
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Delegated
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold leading-none">
                {account.delegatedTotal
                  ? formatToken(account.delegatedTotal, chain.exponent, 2)
                  : "—"}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {account.delegationCount != null
                  ? `${account.delegationCount} validators`
                  : "not applicable"}
              </p>
            </div>
            <div
              className="gata-panel gata-rise p-5"
              style={{
                ["--panel-accent" as string]: accent,
                animationDelay: "120ms",
              }}
            >
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Other Assets
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold leading-none">
                {others.length}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">denominations</p>
            </div>
          </div>

          <div
            className="gata-panel mb-5"
            style={{ ["--panel-accent" as string]: accent }}
          >
            <dl>
              <Row label="Address">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 break-all font-mono text-xs">{address}</span>
                  <CopyButton value={address} label="address" />
                </div>
              </Row>
              <Row label="Account Number">
                <span className="font-mono text-xs">
                  {account.accountNumber ?? "—"}
                </span>
              </Row>
              <Row label="Sequence">
                <span className="font-mono text-xs">{account.sequence ?? "—"}</span>
              </Row>
            </dl>
          </div>

          {account.balances.length > 0 ? (
            <>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                Balances ({account.balances.length})
              </h2>
              <div className="gata-panel overflow-x-auto">
                <table className="gata-table w-full text-sm sm:min-w-[420px]">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-4 py-3 font-medium text-muted-foreground">
                        Denom
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.balances.map((b) => (
                      <tr
                        key={b.denom}
                        className="border-b border-border/50 last:border-0 hover:bg-[var(--gata-card-hi)]/60"
                      >
                        <td
                          data-label="Denom"
                          data-primary
                          className="px-4 py-3 font-mono text-xs"
                          title={b.denom}
                        >
                          {denomLabel(b.denom, symbol, chain.denom, traces.get(b.denom))}
                          {traces.get(b.denom)?.channels.length ? (
                            <span className="ml-2 font-sans text-[11px] text-muted-foreground">
                              via {traces.get(b.denom)!.channels.join(" → ")}
                            </span>
                          ) : null}
                        </td>
                        <td
                          data-label="Amount"
                          className="px-4 py-3 text-right font-mono tabular-nums"
                        >
                          {b.denom === chain.denom
                            ? exactAmount(b.amount, chain.exponent)
                            : Number(b.amount).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      )}

      {/* Outside the exists check on purpose: an address can have history and a
          zero balance, and that history is the interesting part. */}
      <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">
        Transactions
      </h2>
      <Suspense fallback={<LoadingPanel label="Loading transactions…" rows={5} />}>
        <AccountTxs chain={chain} address={address} />
      </Suspense>
    </main>
  );
}
