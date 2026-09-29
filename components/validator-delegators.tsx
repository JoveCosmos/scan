import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ChainConfig } from "@/lib/chains";
import { symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { formatToken } from "@/lib/overview";
import { truncateMiddle } from "@/lib/format";
import { RowDeck, type DeckRow } from "@/components/row-deck";

/** Delegators per server page. The deck pages these to fit the frame. */
export const DELEGATOR_PAGE = 100;

/**
 * Delegators, largest first, every one of them reachable.
 *
 * The whole ranking is read once and cached (lib/validators); each server page
 * is a slice of it, so moving through 23,000 delegators costs one read. Still
 * streamed separately — the first read is the slowest thing on the page.
 */
export async function ValidatorDelegators({
  chain,
  operatorAddress,
  page = 0,
}: {
  chain: ChainConfig;
  operatorAddress: string;
  /** Zero-based server page. */
  page?: number;
}) {
  const result = await getAdapter(chain).getDelegators(operatorAddress, {
    offset: page * DELEGATOR_PAGE,
    limit: DELEGATOR_PAGE,
  });
  const { delegators, total, truncated, failed } = result;
  const offset = result.offset ?? page * DELEGATOR_PAGE;
  const symbol = symbolFor(chain);
  const accent = accentFor(chain);

  // The largest share on the page sets the bar scale, so bars compare
  // delegators to each other rather than to the whole stake, where every bar
  // on a set of 4,000 would be an invisible sliver.
  const topShare = delegators[0]?.share || 1;

  const rows: DeckRow[] = delegators.map((d, i) => ({
    key: d.address,
    cells: [
      { v: String(offset + i + 1), mono: true, dim: true, align: "right" },
      { v: truncateMiddle(d.address, 14, 8), mono: true, address: d.address },
      {
        v: `${formatToken(d.amount, chain.exponent, 2)} ${symbol}`,
        mono: true,
        align: "right",
      },
      {
        v: `${(d.share * 100).toFixed(2)}%`,
        mono: true,
        align: "right",
        bar: d.share / topShare,
      },
    ],
    detail: {
      title: truncateMiddle(d.address, 16, 10),
      sub: `#${offset + i + 1}`,
      rows: [
        { label: "Delegator", value: d.address, mono: true, address: d.address },
        {
          label: "Delegated",
          value: `${formatToken(d.amount, chain.exponent, 6)} ${symbol}`,
          mono: true,
        },
        { label: "Share", value: `${(d.share * 100).toFixed(4)}%`, mono: true },
      ],
      action: { label: "Account", href: `/${chain.chainId}/accounts/${d.address}` },
    },
  }));

  const pages = total !== null ? Math.max(1, Math.ceil(total / DELEGATOR_PAGE)) : 1;
  const base = `/${chain.chainId}/validators/${operatorAddress}?tab=delegators`;
  const pageHref = (p: number) => (p === 0 ? base : `${base}&dp=${p + 1}`);

  const toolbar =
    total !== null && total > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <span className="inline-flex items-baseline gap-1 rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5">
          <span className="font-mono font-semibold text-foreground">
            {total.toLocaleString()}
            {truncated ? "+" : ""}
          </span>
          <span className="text-muted-foreground">delegators</span>
        </span>
        {result.top10Share != null && total > 10 ? (
          <span className="inline-flex items-baseline gap-1 rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5">
            <span className="text-muted-foreground">top 10 hold</span>
            <span className="font-mono font-semibold text-foreground">
              {(result.top10Share * 100).toFixed(1)}%
            </span>
          </span>
        ) : null}
        {pages > 1 ? (
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <span>
              {(offset + 1).toLocaleString()}–{(offset + delegators.length).toLocaleString()}
            </span>
            <PageLink href={page > 0 ? pageHref(page - 1) : null} label="Previous delegators">
              <ChevronLeft className="h-3.5 w-3.5" />
            </PageLink>
            <PageLink href={page < pages - 1 ? pageHref(page + 1) : null} label="Next delegators">
              <ChevronRight className="h-3.5 w-3.5" />
            </PageLink>
          </span>
        ) : null}
      </div>
    ) : undefined;

  return (
    <RowDeck
      accent={accent}
      columns={[
        { label: "#", align: "right", width: "10%", phoneWidth: "13%" },
        { label: "Delegator" },
        { label: "Amount", align: "right", width: "28%", phoneWidth: "40%" },
        { label: "Share", align: "right", width: "18%", phoneHide: true },
      ]}
      rows={rows}
      toolbar={toolbar}
      empty={failed ? "N/A" : "No delegations"}
    />
  );
}

function PageLink({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  const cls =
    "rounded-md border border-border p-1 transition-colors hover:border-[var(--gata-border-hi)] hover:text-foreground";
  if (!href) {
    return (
      <span aria-disabled="true" className={`${cls} opacity-35`}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} scroll={false} className={cls}>
      {children}
    </Link>
  );
}
