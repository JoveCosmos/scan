import { PageFrame } from "@/components/page-frame";

/** A height above the head, or one no node we read still holds. */
export default function BlockNotFound() {
  return (
    <PageFrame title="Block not found">
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-sm uppercase tracking-[0.14em] text-[var(--gata-faint)]">N/A</p>
      </div>
    </PageFrame>
  );
}
