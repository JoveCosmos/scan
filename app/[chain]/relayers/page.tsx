import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { getChannels, resolveCounterparties } from "@/lib/relayers";
import { RelayerOperators } from "@/components/relayer-operators";
import { LoadingPanel } from "@/components/loading-panel";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} relayers` : "Relayers" };
}

/**
 * IBC connectivity for one chain: where it is connected, and who keeps those
 * connections working.
 *
 * The two halves answer different questions and come from different places.
 * Channels are chain state and are always available. Operators are transaction
 * history and need an index — so the page shows what it can and says what it
 * cannot, rather than degrading to a blank table.
 */
export default async function RelayersPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain) notFound();

  // gno.land has no IBC module at all, so there is no page to render — same
  // condition the header uses to decide whether the tab exists.
  if (chain.kind !== "cosmos") notFound();

  const accent = accentFor(chain);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-xl font-medium">Relayers</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        The IBC channels {chain.prettyName} keeps open, and the operators who
        carry packets across them.
      </p>

      <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">
        Operators
      </h2>
      <Suspense
        fallback={
          <LoadingPanel
            label="Counting relays…"
            hint="Attributing every IBC message to the operator who paid for it."
            rows={5}
          />
        }
      >
        <RelayerOperators chain={chain} />
      </Suspense>

      <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">
        Channels
      </h2>
      <Suspense
        fallback={
          <LoadingPanel
            label="Reading channels…"
            hint="Resolving which chain sits on the other end of each one."
            rows={6}
          />
        }
      >
        <Channels chainId={chainId} accent={accent} />
      </Suspense>
    </main>
  );
}

async function Channels({ chainId, accent }: { chainId: string; accent: string }) {
  const chain = getChain(chainId)!;
  const channels = await resolveCounterparties(chain, await getChannels(chain));

  if (channels.length === 0) {
    return (
      <div className="gata-panel px-5 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No IBC channels found on {chain.prettyName}.
        </p>
      </div>
    );
  }

  const open = channels.filter((c) => c.state === "open").length;

  return (
    <>
      <div
        className="gata-panel overflow-x-auto"
        style={{ ["--panel-accent" as string]: accent }}
      >
        <table className="gata-table w-full text-sm sm:min-w-[720px]">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">
                Channel
              </th>
              <th className="px-4 py-3 font-medium text-muted-foreground">
                Counterparty
              </th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Port</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">
                Connection
              </th>
              <th className="px-4 py-3 font-medium text-muted-foreground">
                State
              </th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr
                key={`${c.portId}/${c.channelId}`}
                className="border-b border-border/50 last:border-0"
              >
                <td className="px-4 py-2.5 font-mono text-xs">{c.channelId}</td>
                <td className="px-4 py-2.5">
                  <Counterparty channel={c} />
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                  {c.portId}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                  {c.connectionId}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={
                      c.state === "open"
                        ? "text-xs text-[var(--gata-green)]"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {c.state}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {open.toLocaleString()} open of {channels.length.toLocaleString()}{" "}
        channels. Counterparty chains are read from each channel&apos;s client
        state, and are resolved for open channels only.
      </p>
    </>
  );
}

function Counterparty({
  channel,
}: {
  channel: {
    counterpartyChainId: string | null;
    counterpartyName: string | null;
    counterpartyChannelId: string;
  };
}) {
  const { counterpartyChainId, counterpartyName, counterpartyChannelId } = channel;

  return (
    <span className="flex flex-col">
      {counterpartyName && counterpartyChainId ? (
        // Only linked when it is a chain this explorer actually serves.
        <Link
          href={`/${counterpartyChainId}/relayers`}
          className="transition-colors hover:text-primary"
        >
          {counterpartyName}
        </Link>
      ) : (
        <span className={counterpartyChainId ? "" : "text-muted-foreground"}>
          {counterpartyChainId ?? "unresolved"}
        </span>
      )}
      <span className="font-mono text-[11px] text-muted-foreground">
        {counterpartyChannelId || "-"}
      </span>
    </span>
  );
}
