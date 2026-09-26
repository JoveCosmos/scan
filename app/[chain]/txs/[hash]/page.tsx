import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChain, getAllChains, accentFor } from "@/lib/chains";
import { formatCoinsExact } from "@/lib/coin";
import { getAdapter, type TxView } from "@/lib/adapter";
import { decodeParam, timeAgo, truncateMiddle } from "@/lib/format";
import { denomsForTxs, ibcCounterparts, type IbcCounterpart } from "@/lib/txs";
import { routeAddress } from "@/lib/address-route";
import { PageFrame } from "@/components/page-frame";
import { SectionTabs } from "@/components/section-tabs";
import { CopyButton } from "@/components/copy-button";
import { AddressLink } from "@/components/address-link";
import { EventList, MessageCard, RawJson, SummaryRow } from "./tx-view";

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

  const sections = [
    { key: "messages", label: `Messages · ${tx.messageCount}`, content: messagesPanel },
    ...(events.length
      ? [
          {
            key: "events",
            label: `Events · ${events.length}`,
            content: (
              <div className="h-full overflow-y-auto pr-1">
                <EventList
                  events={events}
                  isAddress={(v) => routeAddress(v, chainId, prefixes) !== null}
                />
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
    <PageFrame title="Transaction" sub={`${chain.prettyName} · ${status}`} accent={accent}>
      <div className="flex h-full flex-col gap-3">
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
                  {tx.codespace ? `${tx.codespace} · ` : ""}code {tx.code}
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
              <span className="font-mono text-[12.5px]">{utc(tx.time) ?? "—"}</span>
              <span className="ml-1.5 text-[12px] text-muted-foreground">{timeAgo(tx.time)}</span>
            </SummaryRow>
            <SummaryRow label="Fee">
              <span className="font-mono">{formatCoinsExact(tx.fee, denoms)}</span>
            </SummaryRow>
            {tx.gasUsed || tx.gasWanted ? (
              <SummaryRow label="Gas used / wanted">
                <span className="font-mono">
                  {tx.gasUsed ? Number(tx.gasUsed).toLocaleString() : "—"} /{" "}
                  {tx.gasWanted ? Number(tx.gasWanted).toLocaleString() : "—"}
                </span>
                {gasPct !== null ? (
                  <span className="ml-1.5 text-[12px] text-muted-foreground">{gasPct.toFixed(1)}%</span>
                ) : null}
              </SummaryRow>
            ) : null}
            {signers.length > 0 ? (
              <SummaryRow label={signers.length === 1 ? "Signer" : "Signers"}>
                <span className="flex flex-col">
                  {signers.map((s) => (
                    <AddressLink key={s} address={s} head={14} tail={8} />
                  ))}
                </span>
              </SummaryRow>
            ) : null}
            {feePayer ? (
              <SummaryRow label="Fee payer">
                <AddressLink address={feePayer} head={14} tail={8} />
              </SummaryRow>
            ) : null}
            {tx.feeGranter ? (
              <SummaryRow label="Fee granter">
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
        <div className="min-h-0 flex-1">
          <SectionTabs sections={sections} initial={tab} param="tab" />
        </div>
      </div>
    </PageFrame>
  );
}
