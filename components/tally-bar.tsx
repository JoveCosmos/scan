import { tallyShares, type Tally } from "@/lib/proposals";

const OPTIONS = [
  { key: "yes", label: "Yes", color: "var(--gata-green)" },
  { key: "no", label: "No", color: "var(--gata-burn)" },
  { key: "veto", label: "No with Veto", color: "var(--gata-amber)" },
  { key: "abstain", label: "Abstain", color: "var(--gata-faint)" },
] as const;

/**
 * Stacked vote bar. The veto segment is omitted entirely when the chain's gov
 * module has no such option (AtomOne), rather than drawn as a zero.
 */
export function TallyBar({
  tally,
  showLegend = true,
}: {
  tally: Tally;
  showLegend?: boolean;
}) {
  const shares = tallyShares(tally);
  const hasVotes = Number(tally.total) > 0;
  const options = OPTIONS.filter((o) => o.key !== "veto" || tally.veto !== null);

  return (
    <div className="space-y-2">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={
          hasVotes
            ? options
                .map((o) => `${o.label} ${(shares[o.key] * 100).toFixed(1)}%`)
                .join(", ")
            : "No votes cast"
        }
      >
        {hasVotes
          ? options.map((o) => (
              <span
                key={o.key}
                style={{
                  width: `${shares[o.key] * 100}%`,
                  background: o.color,
                }}
              />
            ))
          : null}
      </div>

      {showLegend ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {options.map((o) => (
            <span key={o.key} className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: o.color }}
                aria-hidden="true"
              />
              <span className="text-muted-foreground">{o.label}</span>
              <span className="font-mono tabular-nums">
                {hasVotes ? `${(shares[o.key] * 100).toFixed(1)}%` : "—"}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
