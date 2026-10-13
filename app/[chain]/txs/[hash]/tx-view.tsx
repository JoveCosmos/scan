import Link from "next/link";
import { AddressLink } from "@/components/address-link";
import { CopyButton } from "@/components/copy-button";
import { formatCoinsExact, type DenomInfo } from "@/lib/coin";
import { parseCoinString, type DecodedField } from "@/lib/msg-decode";
import type { TxEvent, TxMessage, IbcCounterpart } from "@/lib/txs";

/**
 * The pieces of the transaction page. Server-rendered; the only client parts
 * are the address links and copy buttons they contain.
 */

export function SummaryRow({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${wide ? "col-span-2 lg:col-span-4" : ""}`}>
      <dt className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[13px] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function FieldValue({ field, denoms }: { field: DecodedField; denoms: DenomInfo[] }) {
  const v = field.value;
  switch (v.kind) {
    case "address":
      return <AddressLink address={v.address} full className="break-all text-[12.5px]" />;
    case "link":
      return (
        <Link
          href={v.href}
          className={`text-primary underline decoration-transparent underline-offset-2 hover:decoration-current ${v.mono ? "font-mono" : ""}`}
        >
          {v.text}
        </Link>
      );
    case "coins":
      return <span className="font-mono">{formatCoinsExact(v.coins, denoms)}</span>;
    case "json":
      return (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border bg-[var(--gata-bg2)] p-2 font-mono text-[11.5px] leading-relaxed">
          {v.json}
        </pre>
      );
    default:
      return <span className={v.mono ? "font-mono" : undefined}>{v.text}</span>;
  }
}

/** Fields for a message the decoder had nothing for: gno, indexed rows. */
function fallbackFields(m: TxMessage): DecodedField[] {
  const t = m.transfer;
  if (!t) return [];
  return [
    ...(t.from ? [{ label: "From", value: { kind: "address" as const, address: t.from } }] : []),
    ...(t.to ? [{ label: "To", value: { kind: "address" as const, address: t.to } }] : []),
    ...(t.amount.length ? [{ label: "Amount", value: { kind: "coins" as const, coins: t.amount } }] : []),
  ];
}

export function MessageCard({
  message,
  index,
  denoms,
  counterpart,
  nested = false,
}: {
  message: TxMessage;
  index: number;
  denoms: DenomInfo[];
  counterpart?: IbcCounterpart;
  nested?: boolean;
}) {
  const fields = message.fields?.length ? message.fields : fallbackFields(message);
  return (
    <section
      className={
        nested
          ? "border-l-2 border-[var(--gata-border-hi)] pl-3"
          : "gata-surface px-4 py-3"
      }
    >
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[11px] text-muted-foreground">#{index + 1}</span>
        <h3 className="text-[14px] font-semibold">{message.label}</h3>
        <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--gata-faint)]">
          {message.typeUrl}
        </span>
      </header>
      {fields.length > 0 || counterpart ? (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_1fr]">
          {fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="contents">
              <dt className="text-[12px] text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0 text-[13px] [overflow-wrap:anywhere]">
                <FieldValue field={f} denoms={denoms} />
              </dd>
            </div>
          ))}
          {counterpart ? (
            <>
              <dt className="text-[12px] text-muted-foreground">Counterparty</dt>
              <dd className="text-[13px]">
                {counterpart.counterpartyName ? (
                  <Link
                    href={`/${counterpart.counterpartyChainId}/params`}
                    className="text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
                  >
                    {counterpart.counterpartyName}
                  </Link>
                ) : (
                  <span className="font-mono">{counterpart.counterpartyChainId ?? "N/A"}</span>
                )}
              </dd>
              {counterpart.counterpartyName ? (
                <>
                  <dt className="text-[12px] text-muted-foreground">
                    {counterpart.role === "receive" ? "Received in" : "Sent in"}
                  </dt>
                  <dd className="min-w-0 text-[13px]">
                    {counterpart.txHash ? (
                      <Link
                        href={`/${counterpart.counterpartyChainId}/txs/${counterpart.txHash}`}
                        className="break-all font-mono text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
                      >
                        {counterpart.txHash}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">N/A</span>
                    )}
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
      ) : null}
      {message.inner?.length ? (
        <div className="mt-3 flex flex-col gap-3">
          {message.inner.map((m, i) => (
            <MessageCard key={`${i}-${m.typeUrl}`} message={m} index={i} denoms={denoms} nested />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * "1779391693uatone,92199uphoton": an event's coin list, in base units.
 * Reward and commission events carry decimal base units ("12.5uatom"); a
 * fraction of a base unit is not worth showing, so it is dropped.
 */
const COIN_LIST = /^\d+(\.\d+)?[a-zA-Z][\w/:.-]*(,\d+(\.\d+)?[a-zA-Z][\w/:.-]*)*$/;
const coinsOf = (v: string) => parseCoinString(v.replace(/(\d+)\.\d+/g, "$1"));

export function EventList({
  events,
  isAddress,
  denoms,
}: {
  events: TxEvent[];
  /** Whether an attribute value is an address we can route. */
  isAddress: (value: string) => boolean;
  /** To show coin amounts in whole tokens, with the raw value on hover. */
  denoms: DenomInfo[];
}) {
  const groups = new Map<string, TxEvent[]>();
  for (const e of events) {
    const key = e.msgIndex === null ? "Transaction" : `Message #${e.msgIndex + 1}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([group, list]) => (
        <section key={group} className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{group}</h3>
          {list.map((e, i) => (
            <div key={`${e.type}-${i}`} className="gata-surface overflow-hidden">
              <div className="border-b border-border bg-[var(--gata-bg2)] px-3 py-1.5 font-mono text-[12px] font-semibold">
                {e.type}
              </div>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[11rem_1fr]">
                {e.attributes.map((a, j) => (
                  <div key={`${a.key}-${j}`} className="contents">
                    <dt className="font-mono text-[11.5px] text-muted-foreground">{a.key}</dt>
                    <dd className="min-w-0 break-all font-mono text-[11.5px]">
                      {isAddress(a.value) ? (
                        <AddressLink address={a.value} full />
                      ) : COIN_LIST.test(a.value) ? (
                        <span title={a.value}>{formatCoinsExact(coinsOf(a.value), denoms)}</span>
                      ) : (
                        a.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function RawJson({ json }: { json: string }) {
  return (
    <div className="relative h-full">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton value={json} label="raw JSON" />
      </div>
      <pre className="gata-surface h-full overflow-auto p-3 pr-10 font-mono text-[11.5px] leading-relaxed">
        {json}
      </pre>
    </div>
  );
}

/** One IBC packet as this chain saw it, with the far side linked where we carry it. */
export interface PacketTrace {
  packet: import("@/lib/indexer-tx").PacketRow;
  status: string;
  latency: number | null;
  counterpartyName: string | null;
  counterpartyChainId: string | null;
  /** The matching transaction on the other chain, when found. */
  counterpartTx: string | null;
}

function Leg({
  label,
  chainId,
  height,
  tx,
  time,
  relayer,
}: {
  label: string;
  chainId: string;
  height: string | null;
  tx: string | null;
  time: string | null;
  relayer?: string | null;
}) {
  if (!height && !tx) return null;
  return (
    <>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12.5px]">
        {height ? (
          <Link
            href={`/${chainId}/blocks/${height}`}
            className="font-mono text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
          >
            {Number(height).toLocaleString()}
          </Link>
        ) : null}
        {tx ? (
          <Link
            href={`/${chainId}/txs/${encodeURIComponent(tx)}`}
            className="font-mono text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
          >
            {tx.slice(0, 8)}…{tx.slice(-6)}
          </Link>
        ) : null}
        {time ? <span className="text-muted-foreground">{time.slice(0, 19).replace("T", " ")}</span> : null}
        {relayer ? (
          <span className="text-muted-foreground">
            by <AddressLink address={relayer} />
          </span>
        ) : null}
      </dd>
    </>
  );
}

export function IbcTraceList({ traces, chainId }: { traces: PacketTrace[]; chainId: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      {traces.map(({ packet: p, status, latency, counterpartyName, counterpartyChainId, counterpartTx }) => (
        <section key={`${p.direction}-${p.srcChannel}-${p.sequence}`} className="gata-surface px-4 py-3">
          <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="text-[14px] font-semibold">
              {p.direction === "out" ? "Sent" : "Received"}, packet {p.sequence}
            </h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                status === "error" || status === "timeout"
                  ? "bg-[var(--destructive)]/12 text-[var(--destructive)]"
                  : status === "acked" || status === "received"
                    ? "bg-[var(--gata-green)]/12 text-[var(--gata-green)]"
                    : "bg-[var(--gata-card-hi)] text-muted-foreground"
              }`}
            >
              {status === "error" ? "ack error" : status === "timeout" ? "timed out" : status}
            </span>
            {latency !== null ? (
              <span className="font-mono text-[11px] text-muted-foreground">{latency}s</span>
            ) : null}
          </header>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_1fr]">
            <dt className="text-[12px] text-muted-foreground">Channels</dt>
            <dd className="font-mono text-[12.5px]">
              {p.srcPort}/{p.srcChannel} → {p.dstPort ?? "?"}/{p.dstChannel ?? "?"}
            </dd>
            <dt className="text-[12px] text-muted-foreground">Other chain</dt>
            <dd className="text-[12.5px]">
              {counterpartyName && counterpartyChainId ? (
                counterpartTx ? (
                  <Link
                    href={`/${counterpartyChainId}/txs/${encodeURIComponent(counterpartTx)}`}
                    className="text-primary underline decoration-transparent underline-offset-2 hover:decoration-current"
                  >
                    {counterpartyName}, {counterpartTx.slice(0, 8)}…
                  </Link>
                ) : (
                  counterpartyName
                )
              ) : (
                <span className="font-mono text-muted-foreground">{counterpartyChainId ?? "-"}</span>
              )}
            </dd>
            {p.sender ? (
              <>
                <dt className="text-[12px] text-muted-foreground">Sender</dt>
                <dd className="text-[12.5px]"><AddressLink address={p.sender} full /></dd>
              </>
            ) : null}
            {p.receiver ? (
              <>
                <dt className="text-[12px] text-muted-foreground">Receiver</dt>
                <dd className="text-[12.5px]"><AddressLink address={p.receiver} full /></dd>
              </>
            ) : null}
            {p.amount && p.denom ? (
              <>
                <dt className="text-[12px] text-muted-foreground">Amount</dt>
                <dd className="font-mono text-[12.5px]">
                  {p.amount} {p.denom}
                </dd>
              </>
            ) : null}
            <Leg label="Sent" chainId={chainId} height={p.sendHeight} tx={p.sendTx} time={p.sendTime} />
            <Leg
              label="Received"
              chainId={chainId}
              height={p.recvHeight}
              tx={p.recvTx}
              time={p.recvTime}
              relayer={p.recvRelayer}
            />
            <Leg
              label="Acknowledged"
              chainId={chainId}
              height={p.ackHeight}
              tx={p.ackTx}
              time={p.ackTime}
              relayer={p.ackRelayer}
            />
            {p.ackError ? (
              <>
                <dt className="text-[12px] text-muted-foreground">Ack error</dt>
                <dd className="font-mono text-[12px] text-[var(--destructive)] [overflow-wrap:anywhere]">
                  {p.ackError}
                </dd>
              </>
            ) : null}
            {p.timeoutTx ? (
              <Leg label="Timed out" chainId={chainId} height={null} tx={p.timeoutTx} time={null} />
            ) : null}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Every value movement, in event order, as the index recorded it. */
export function MovementList({
  movements,
  denoms,
}: {
  movements: import("@/lib/indexer-tx").MovementRow[];
  denoms: DenomInfo[];
}) {
  return (
    <div className="gata-surface overflow-hidden">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="bg-[var(--gata-bg2)]">
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">To</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m, i) => (
            <tr key={i} className="border-b border-border/40 last:border-0">
              <td className="px-3 py-1.5 text-muted-foreground">{m.kind}</td>
              <td className="px-3 py-1.5"><AddressLink address={m.from} /></td>
              <td className="px-3 py-1.5"><AddressLink address={m.to} /></td>
              <td className="px-3 py-1.5 text-right font-mono">
                {formatCoinsExact([{ denom: m.denom, amount: m.amount }], denoms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
