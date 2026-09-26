import { PageFrame } from "@/components/page-frame";

export default function ProposalNotFound() {
  return (
    <PageFrame title="Proposal not found">
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-sm uppercase tracking-[0.14em] text-[var(--gata-faint)]">N/A</p>
      </div>
    </PageFrame>
  );
}
