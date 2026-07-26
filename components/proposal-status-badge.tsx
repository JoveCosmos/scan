import { proposalStatusLabel } from "@/lib/proposals";

const STATUS_STYLE: Record<string, string> = {
  PROPOSAL_STATUS_PASSED: "bg-[var(--gata-green)]/12 text-[var(--gata-green)]",
  PROPOSAL_STATUS_REJECTED: "bg-[var(--gata-burn)]/12 text-[var(--gata-burn)]",
  PROPOSAL_STATUS_FAILED: "bg-[var(--gata-burn)]/12 text-[var(--gata-burn)]",
  PROPOSAL_STATUS_VOTING_PERIOD: "bg-[var(--gata-blue)]/12 text-[var(--gata-blue)]",
  PROPOSAL_STATUS_DEPOSIT_PERIOD: "bg-[var(--gata-gold)]/12 text-[var(--gata-gold)]",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        STATUS_STYLE[status] ?? "bg-secondary text-muted-foreground"
      }`}
    >
      {proposalStatusLabel(status)}
    </span>
  );
}
