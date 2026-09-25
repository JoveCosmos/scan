import { PageFrame } from "@/components/page-frame";

/**
 * A section this network has nothing to show for: the heading and "N/A".
 *
 * Every network carries every tab, so these routes render rather than 404.
 * No explanation is given, whatever the reason. Whether the chain lacks the
 * module or we chose not to carry it, the answer shown is the same two letters.
 */
export function SectionUnavailable({
  title,
  chainName,
  accent,
}: {
  title: string;
  chainId?: string;
  chainName: string;
  accent: string;
}) {
  return (
    <PageFrame title={title} sub={chainName} accent={accent}>
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-sm uppercase tracking-[0.14em] text-[var(--gata-faint)]">
          N/A
        </p>
      </div>
    </PageFrame>
  );
}
