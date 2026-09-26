import Link from "next/link";
import { ArrowLeftRight, ArrowRight, Box } from "lucide-react";
import { timeAgo, truncateMiddle } from "@/lib/format";
import { ValidatorAvatar } from "@/components/validator-avatar";

/**
 * The overview's lower half: the newest blocks, the newest transactions and
 * the largest validators, each a card with its own way through to the full
 * list. Server-rendered from data the page already has, so it adds no reads.
 */

export interface PanelBlock {
  height: string;
  time: string;
  txCount: number;
  proposer: string | null;
  proposerOperator: string | null;
  proposerLogos: string[];
}

export interface PanelTx {
  hash: string;
  height: string;
  time: string | null;
  label: string;
  ok: boolean | null;
}

export interface PanelValidator {
  operator: string;
  moniker: string;
  share: number;
  logos: string[];
}

function Card({
  title,
  href,
  accent,
  children,
}: {
  title: string;
  href: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="gata-surface flex min-h-0 flex-col overflow-hidden"
      style={{ ["--row-acc" as string]: accent }}
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="font-display text-[14px] font-semibold tracking-[-0.01em]">{title}</h2>
        <Link
          href={href}
          className="group inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--gata-card-hi)] hover:text-foreground"
        >
          View all
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </header>
      <ul className="min-h-0 flex-1 overflow-hidden">{children}</ul>
    </section>
  );
}

function Row({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li className="deck-row border-b border-border/40 last:border-0">
      <Link href={href} className="flex h-[46px] items-center gap-3 px-4">
        {children}
      </Link>
    </li>
  );
}

export function OverviewPanels({
  chainId,
  accent,
  blocks,
  txs,
  validators,
  showTxs,
}: {
  chainId: string;
  accent: string;
  blocks: PanelBlock[];
  txs: PanelTx[];
  validators: PanelValidator[];
  /** The Transactions section is offered on this chain. */
  showTxs: boolean;
}) {
  const maxShare = validators.reduce((m, v) => Math.max(m, v.share), 0) || 1;
  return (
    <div
      className={`grid min-h-0 flex-1 gap-3 overflow-y-auto lg:overflow-hidden ${
        showTxs ? "lg:grid-cols-3" : "lg:grid-cols-2"
      }`}
    >
      <Card title="Latest blocks" href={`/${chainId}/blocks`} accent={accent}>
        {blocks.map((b) => (
          <Row key={b.height} href={`/${chainId}/blocks/${b.height}`}>
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
              style={{ color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)` }}
            >
              <Box className="h-4 w-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-[13px] font-medium text-[var(--gata-blue)]">
                {Number(b.height).toLocaleString()}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {b.proposer ? (
                  <ValidatorAvatar name={b.proposer} logos={b.proposerLogos} size={14} />
                ) : null}
                <span className="truncate">{b.proposer ?? "—"}</span>
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end">
              <span className="font-mono text-[12px]">
                {b.txCount} tx{b.txCount === 1 ? "" : "s"}
              </span>
              <span className="text-[11px] text-muted-foreground">{timeAgo(b.time)}</span>
            </span>
          </Row>
        ))}
      </Card>

      {showTxs ? (
        <Card title="Latest transactions" href={`/${chainId}/txs`} accent={accent}>
          {txs.length === 0 ? (
            <li className="grid h-24 place-items-center text-[13px] text-muted-foreground">N/A</li>
          ) : (
            txs.map((t) => (
              <Row key={t.hash} href={`/${chainId}/txs/${t.hash}`}>
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                  style={{
                    color: t.ok === false ? "var(--destructive)" : "var(--gata-green)",
                    background:
                      t.ok === false
                        ? "color-mix(in srgb, var(--destructive) 12%, transparent)"
                        : "color-mix(in srgb, var(--gata-green) 12%, transparent)",
                  }}
                >
                  <ArrowLeftRight className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[13px] font-medium text-[var(--gata-blue)]">
                    {truncateMiddle(t.hash, 8, 6)}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">{t.label}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="font-mono text-[12px]">#{Number(t.height).toLocaleString()}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t.time ? timeAgo(t.time) : ""}
                  </span>
                </span>
              </Row>
            ))
          )}
        </Card>
      ) : null}

      <Card title="Top validators" href={`/${chainId}/validators`} accent={accent}>
        {validators.map((v, i) => (
          <Row key={v.operator} href={`/${chainId}/validators/${v.operator}`}>
            <span className="w-4 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
              {i + 1}
            </span>
            <ValidatorAvatar name={v.moniker} logos={v.logos} size={30} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-[13px] font-semibold">{v.moniker}</span>
              <span className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--gata-border)]">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(2, (v.share / maxShare) * 100)}%`, background: accent }}
                />
              </span>
            </span>
            <span className="shrink-0 font-mono text-[12px]">{(v.share * 100).toFixed(2)}%</span>
          </Row>
        ))}
      </Card>
    </div>
  );
}
