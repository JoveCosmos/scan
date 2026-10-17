import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, getAllChains, accentFor } from "@/lib/chains";
import { formatCoinsExact } from "@/lib/coin";
import { getAdapter, type TxView } from "@/lib/adapter";
import { decodeParam, timeAgo, truncateMiddle } from "@/lib/format";
import {
  counterpartyChainOf,
  denomsForTxs,
  findPacketTx,
  ibcCounterparts,
  indexedDetailToView,
  type IbcCounterpart,
} from "@/lib/txs";
import {
  packetLatency,
  packetStatus,
  packetsForTx,
  txFromIndex,
  type MovementRow,
} from "@/lib/indexer-tx";
import { indexerHealth } from "@/lib/indexer-coverage";
import { withinBudget } from "@/lib/cache";
import { routeAddress } from "@/lib/address-route";
import { PageFrame } from "@/components/page-frame";
import { SectionTabs } from "@/components/section-tabs";
import { CopyButton } from "@/components/copy-button";
import { AddressLink } from "@/components/address-link";
import {
  EventList,
  IbcTraceList,
  MessageCard,
  MovementList,
  RawJson,
  SummaryRow,
  type PacketTrace,
  TokenTransferList,
} from "./tx-view";
import { tokenHref } from "@/lib/gno-tokens";
import { tokenMeta } from "@/lib/gno-token-data";
import { atName, gnoNames } from "@/lib/gno-users";
import { formatUnits } from "@/lib/format";
import type { GnoTxExtras } from "@/lib/gno";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string; hash: string }>;
}): Promise<Metadata> {
  const { hash } = await params;
  return { title: `Tx ${truncateMiddle(decodeParam(hash), 8, 6)}` };
}

function utc(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * One transaction, the way an explorer should show it: who signed and paid,
 * whether it landed and why not, and every message with its parties by role,
 * each a link. Events and the node's raw response sit in their own tabs; lists
 * scroll inside the frame, the page never does.
 */
export default async function TxDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string; hash: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { chain: chainId, hash: rawHash } = await params;
  const { tab } = await searchParams;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const hash = decodeParam(rawHash);
  const accent = accentFor(chain);

  // Not found and node failure are different answers: "Not found" is the
  // node's word, "N/A" means we couldn't ask. Either way the hash may live on
  // another network, so the one way on is a search across all of them.
  // (Rendered inline: the chain segment streams behind a loading screen, so
  // a 404 status can't be sent from here anyway.)
  let tx: TxView | null;
  let failed = false;
  try {
    tx = await getAdapter(chain).getTx(hash);
  } catch {
    tx = null;
    failed = true;
  }
  // What the node couldn't serve, the index may hold: its own tx search is
  // off on some endpoints, and pruned nodes forget old transactions.
  let movements: MovementRow[] | null = null;
  let fromIndex = false;
  if (!tx && chain.kind === "cosmos") {
    const indexed = await txFromIndex(chain.chainId, hash).catch(() => null);
    if (indexed) {
      tx = indexedDetailToView(indexed, chain.chainId);
      movements = indexed.movements;
      fromIndex = true;
      failed = false;
    }
  }
  // A real miss: the not-found page, marked noindex. A failed read stays here
  // as N/A, since it says nothing about whether the transaction exists.
  if (!tx && !failed) notFound();
  if (!tx) {
    return (
      <PageFrame title="Transaction" sub={`${chain.prettyName} · ${failed ? "N/A" : "Not found"}`} accent={accent}>
        <div className="flex flex-col gap-2 text-sm">
          <span className="break-all font-mono text-muted-foreground">{hash}</span>
          <Link
            href={`/search?q=${encodeURIComponent(hash)}`}
            className="text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
          >
            Search all chains
          </Link>
        </div>
      </PageFrame>
    );
  }

  const all = getAllChains();
  const prefixes = all.map((c) => ({
    chainId: c.chainId,
    bech32Prefix: c.bech32Prefix,
    network: c.network,
  }));
  const [denoms, counterparts] = await Promise.all([
    chain.kind === "cosmos" ? denomsForTxs(chain, [tx]) : Promise.resolve([]),
    chain.kind === "cosmos" && tx.rawJson
      ? ibcCounterparts(chain, { ...tx, rawLog: tx.rawLog ?? "", signers: tx.signers ?? [], timeoutHeight: tx.timeoutHeight ?? null }, all).catch(
          () => [] as IbcCounterpart[]
        )
      : Promise.resolve([] as IbcCounterpart[]),
  ]);
  const cpBy = new Map(counterparts.map((c) => [c.index, c]));

  // IBC packets this transaction moved, with the far side linked where we
  // carry the other chain.
  const [packets, health] = await Promise.all([
    chain.kind === "cosmos" ? packetsForTx(chain.chainId, tx.hash).catch(() => null) : null,
    fromIndex ? indexerHealth(chain.chainId) : null,
  ]);
  const traces: PacketTrace[] = await Promise.all(
    (packets ?? []).map(async (p) => {
      const localPort = p.direction === "out" ? p.srcPort : (p.dstPort ?? "transfer");
      const localChannel = p.direction === "out" ? p.srcChannel : (p.dstChannel ?? "");
      const cpId = localChannel
        ? await counterpartyChainOf(chain, localPort, localChannel).catch(() => null)
        : null;
      const cp = cpId ? all.find((c) => c.chainId === cpId && c.kind === "cosmos") : undefined;
      const counterpartTx = cp
        ? await findPacketTx(
            cp,
            p.direction === "out" ? "recv_packet" : "send_packet",
            p.srcChannel,
            p.sequence
          ).catch(() => null)
        : null;
      return {
        packet: p,
        status: packetStatus(p),
        latency: packetLatency(p),
        counterpartyName: cp?.prettyName ?? null,
        counterpartyChainId: cpId,
        counterpartTx,
      };
    })
  );

  const ok = tx.code === 0;
  const status = tx.code === null ? "unindexed" : ok ? "success" : "failed";
  const gasPct =
    tx.gasUsed && tx.gasWanted && Number(tx.gasWanted) > 0
      ? (Number(tx.gasUsed) / Number(tx.gasWanted)) * 100
      : null;
  const signers = tx.signers ?? (tx.signer ? [tx.signer] : []);
  const feePayer = tx.feePayer && !signers.includes(tx.feePayer) ? tx.feePayer : null;
  const events = tx.events ?? [];

  const messagesPanel = (
    <div className="h-full overflow-y-auto pr-1">
      <div className="flex flex-col gap-2.5">
        {tx.messages.length === 0 ? (
          <p className="font-mono text-sm text-[var(--gata-faint)]">N/A</p>
        ) : (
          tx.messages.map((m, i) => (
            <MessageCard
              key={`${i}-${m.typeUrl}`}
              message={m}
              index={i}
              denoms={denoms}
              counterpart={cpBy.get(i)}
            />
          ))
        )}
      </div>
    </div>
  );

  // gno.land: GRC20 transfers, named from the token state (built at boot).
  const gnoExtras = (tx as TxView & { gno?: GnoTxExtras }).gno;
  const grc20 = gnoExtras?.tokenTransfers ?? [];
  const [tokenState, names] = grc20.length
    ? await Promise.all([withinBudget(tokenMeta(chain), 1500, null), withinBudget(gnoNames(chain), 1500, null)])
    : [null, null];
  const tokenRows = grc20.map((t) => {
    const token = tokenState?.get(t.token) ?? null;
    const symbol = token?.symbol ?? t.token.split(".").slice(-2, -1)[0] ?? t.token;
    return {
      symbol,
      href: token ? tokenHref(chainId, token) : null,
      from: t.from || null,
      to: t.to || null,
      fromName: atName(names, t.from),
      toName: atName(names, t.to),
      amount: token ? formatUnits(t.value, token.decimals) : t.value,
    };
  });

  const sections = [
    { key: "messages", label: `Messages (${tx.messageCount})`, content: messagesPanel },
    ...(tokenRows.length
      ? [
          {
            key: "tokens",
            label: `Tokens (${tokenRows.length})`,
            content: (
              <div className="h-full overflow-y-auto pr-1">
                <TokenTransferList transfers={tokenRows} />
              </div>
            ),
          },
        ]
      : []),
    ...(events.length
      ? [
          {
            key: "events",
            label: `Events (${events.length})`,
            content: (
              <div className="h-full overflow-y-auto pr-1">
                <EventList
                  events={events}
                  isAddress={(v) => routeAddress(v, chainId, prefixes) !== null}
                  denoms={denoms}
                />
              </div>
            ),
          },
        ]
      : []),
    ...(traces.length
      ? [
          {
            key: "ibc",
            label: `IBC (${traces.length})`,
            content: (
              <div className="h-full overflow-y-auto pr-1">
                <IbcTraceList traces={traces} chainId={chainId} />
              </div>
            ),
          },
        ]
      : []),
    ...(movements && movements.length
      ? [
          {
            key: "movements",
            label: `Movements (${movements.length})`,
            content: (
              <div className="h-full overflow-y-auto pr-1">
                <MovementList movements={movements} denoms={denoms} />
              </div>
            ),
          },
        ]
      : []),
    ...(tx.rawJson
      ? [{ key: "raw", label: "Raw JSON", content: <RawJson json={tx.rawJson} /> }]
      : []),
  ];

  return (
    <PageFrame
      title="Transaction"
      sub={[
        chain.prettyName,
        status,
        ...(fromIndex ? ["indexed"] : []),
        ...(health?.stale ? ["Index behind"] : []),
      ].join(" · ")}
      accent={accent}
    >
      {/* The list takes whatever height is left at every width. On a screen
          too short for its minimum the body scrolls instead. */}
      <div className="flex h-full flex-col gap-2.5 overflow-y-auto sm:gap-3 lg:overflow-hidden">
        <div className="gata-surface shrink-0 px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 lg:grid-cols-4">
            <SummaryRow label="Hash" wide>
              <span className="inline-flex max-w-full items-center gap-1">
                <span className="break-all font-mono text-[12.5px]">{tx.hash}</span>
                <CopyButton value={tx.hash} label="hash" />
              </span>
            </SummaryRow>
            <SummaryRow label="Status">
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  tx.code === null
                    ? "bg-[var(--gata-card-hi)] text-muted-foreground"
                    : ok
                      ? "bg-[var(--gata-green)]/12 text-[var(--gata-green)]"
                      : "bg-[var(--destructive)]/12 text-[var(--destructive)]"
                }`}
              >
                {status === "success" ? "Success" : status === "failed" ? "Failed" : "Unindexed"}
              </span>
              {!ok && tx.code !== null ? (
                <span className="ml-2 font-mono text-[12px] text-muted-foreground">
                  {tx.codespace ? `${tx.codespace}, ` : ""}code {tx.code}
                </span>
              ) : null}
            </SummaryRow>
            <SummaryRow label="Height">
              <Link
                href={`/${chainId}/blocks/${tx.height}`}
                className="font-mono text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
              >
                {Number(tx.height).toLocaleString()}
              </Link>
            </SummaryRow>
            <SummaryRow label="Time">
              {/* Date and clock each stay whole; on a phone they stack, and the
                  age takes its own line rather than running into the clock. */}
              <span className="font-mono text-[12.5px]">
                {(utc(tx.time) ?? "-").split(/ (.*)/).filter(Boolean).map((part, i) => (
                  <span key={i} className="whitespace-nowrap">
                    {i > 0 ? " " : ""}
                    {part}
                  </span>
                ))}
              </span>
              <span className="block text-[12px] text-muted-foreground sm:ml-1.5 sm:inline">
                {timeAgo(tx.time)}
              </span>
            </SummaryRow>
            <SummaryRow label="Fee">
              <span className="font-mono">{formatCoinsExact(tx.fee, denoms)}</span>
            </SummaryRow>
            {tx.gasUsed || tx.gasWanted ? (
              <SummaryRow label="Gas used / wanted" phoneWide>
                <span className="whitespace-nowrap font-mono">
                  {tx.gasUsed ? Number(tx.gasUsed).toLocaleString() : "-"} /{" "}
                  {tx.gasWanted ? Number(tx.gasWanted).toLocaleString() : "-"}
                </span>
                {gasPct !== null ? (
                  <span className="block text-[12px] text-muted-foreground sm:ml-1.5 sm:inline">
                    {gasPct.toFixed(1)}%
                  </span>
                ) : null}
              </SummaryRow>
            ) : null}
            {signers.length > 0 ? (
              <SummaryRow label={signers.length === 1 ? "Signer" : "Signers"} phoneWide>
                <span className="flex flex-col">
                  {signers.map((s) => (
                    <AddressLink key={s} address={s} head={14} tail={8} />
                  ))}
                </span>
              </SummaryRow>
            ) : null}
            {feePayer ? (
              <SummaryRow label="Fee payer" phoneWide>
                <AddressLink address={feePayer} head={14} tail={8} />
              </SummaryRow>
            ) : null}
            {tx.feeGranter ? (
              <SummaryRow label="Fee granter" phoneWide>
                <AddressLink address={tx.feeGranter} head={14} tail={8} />
              </SummaryRow>
            ) : null}
            {tx.timeoutHeight && tx.timeoutHeight !== "0" ? (
              <SummaryRow label="Timeout height">
                <span className="font-mono">{Number(tx.timeoutHeight).toLocaleString()}</span>
              </SummaryRow>
            ) : null}
            {tx.memo ? (
              <SummaryRow label="Memo" wide>
                <span className="break-words">{tx.memo}</span>
              </SummaryRow>
            ) : null}
            {!ok && tx.code !== null && tx.rawLog ? (
              <SummaryRow label="Error" wide>
                <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/[0.06] p-2 font-mono text-[11.5px] text-[var(--destructive)]">
                  {tx.rawLog}
                </pre>
              </SummaryRow>
            ) : null}
          </dl>
        </div>
        <div className="min-h-[18rem] flex-1 lg:min-h-0">
          <SectionTabs sections={sections} initial={tab} param="tab" />
        </div>
      </div>
    </PageFrame>
  );
}
