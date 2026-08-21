import Link from "next/link";
import { PageFrame } from "@/components/page-frame";

/**
 * A section this network has nothing to show for.
 *
 * These routes used to 404, which was right while the tab was hidden — an
 * absent tab and an absent page agreed with each other. Now that every network
 * carries every tab, a 404 would contradict the rail that just linked here.
 *
 * There are two reasons a section is empty and they are not the same claim. The
 * chain may have no such module, which is a fact about the chain and is said
 * plainly. Or we may not carry it, which is a decision of ours about cost — that
 * is stated as our doing and left there. Explaining *why* we made it would turn
 * an internal judgement into a public claim about the network, which is the one
 * thing this page must not do.
 */
export function SectionUnavailable({
  title,
  chainId,
  chainName,
  accent,
  /** Absent because the chain has no such module, rather than by our choice. */
  reason,
}: {
  title: string;
  chainId: string;
  chainName: string;
  accent: string;
  reason?: string;
}) {
  return (
    <PageFrame title={title} sub={chainName} accent={accent}>
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--gata-faint)]">
            N/A
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {reason ?? `${title} are not available for ${chainName} on GATA SCAN.`}
          </p>
          <Link
            href={`/${chainId}/params`}
            className="mt-5 inline-flex text-sm text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
          >
            {chainName} overview →
          </Link>
        </div>
      </div>
    </PageFrame>
  );
}
