import { statusLabel } from "@/lib/validators";

/**
 * Consensus standing, which is separate from uptime: a validator can be signing
 * perfectly and still be jailed, and tombstoning is permanent regardless of
 * current signing.
 */
export function ValidatorStatus({
  jailed,
  status,
  tombstoned = false,
}: {
  jailed: boolean;
  status: string;
  tombstoned?: boolean;
}) {
  const label = tombstoned ? "Tombstoned" : jailed ? "Jailed" : statusLabel(status);

  // Tombstoned is worse than jailed — it cannot be undone — so it gets the
  // stronger treatment rather than sharing the jailed style.
  const tone = tombstoned
    ? "bg-[var(--gata-burn)]/20 text-[var(--gata-burn)] ring-1 ring-[var(--gata-burn)]/30"
    : jailed
      ? "bg-[var(--gata-burn)]/12 text-[var(--gata-burn)]"
      : status === "BOND_STATUS_BONDED" || status === "ACTIVE"
        ? "bg-[var(--gata-green)]/12 text-[var(--gata-green)]"
        : "bg-secondary text-muted-foreground";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${tone}`}>
      {label}
    </span>
  );
}
