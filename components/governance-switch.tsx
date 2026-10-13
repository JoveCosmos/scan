import Link from "next/link";

/**
 * Proposals or governors: two views of a chain's governance, for chains that
 * have governors (AtomOne). The same control as the validators' Active or
 * Inactive switch, but links, since each view is its own page.
 */
export function GovernanceSwitch({
  chainId,
  current,
  counts,
}: {
  chainId: string;
  current: "proposals" | "governors";
  counts?: { proposals?: number | null; governors?: number | null };
}) {
  const items = [
    ["proposals", "Proposals", counts?.proposals],
    ["governors", "Governors", counts?.governors],
  ] as const;
  return (
    <nav
      aria-label="Governance"
      className="inline-flex shrink-0 rounded-lg border border-border bg-[var(--gata-card)] p-0.5"
    >
      {items.map(([key, label, count]) => (
        <Link
          key={key}
          href={`/${chainId}/${key}`}
          aria-current={current === key ? "page" : undefined}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
            current === key
              ? "bg-[var(--gata-card-hi)] text-foreground shadow-[inset_0_0_0_1px_var(--gata-border-hi)]"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
          {count != null ? (
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
