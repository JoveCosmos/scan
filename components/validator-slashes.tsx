import type { ChainConfig } from "@/lib/chains";
import { symbolFor } from "@/lib/chains";
import { formatToken } from "@/lib/overview";
import { slashHistory, type SlashKind } from "@/lib/indexer-db";
import { consensusIdsFromPubkey } from "@/lib/uptime";

/**
 * A validator's jailing and slashing history.
 *
 * Renders nothing at all unless the indexer can answer. No node can: the
 * staking module keeps only the current jailed flag, so a validator jailed
 * three times and one jailed once are indistinguishable through the API, and a
 * validator that recovered looks like one that was never jailed. Absent this
 * table there is no section to degrade, which is why this returns null rather
 * than an error panel.
 */
export async function ValidatorSlashes({
  chain,
  consensusPubkey,
}: {
  chain: ChainConfig;
  consensusPubkey: string | null;
}) {
  if (!consensusPubkey) return null;

  const ids = consensusIdsFromPubkey(consensusPubkey, chain.bech32Prefix);
  if (!ids) return null;

  const history = await slashHistory(chain.chainId, ids.valcons);
  if (!history) return null;

  const { events, since } = history;
  const symbol = symbolFor(chain);

  // Counted rather than listed, because "jailed twice" is the fact people come
  // to this page for; the table below is the evidence.
  const jailings = events.filter((e) => e.kind === "jailed").length;
  const tombstoned = events.some((e) => e.kind === "tombstoned");

  const window = new Date(since).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <>
      <h2 className="mt-6 mb-3 text-sm font-medium text-muted-foreground">
        Jailing history
      </h2>

      {events.length === 0 ? (
        <div className="gata-panel px-5 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            Never jailed or slashed since {window}.
          </p>
        </div>
      ) : (
        <div className="gata-panel overflow-x-auto">
          <div className="border-b border-border px-4 py-3 text-sm">
            {tombstoned ? (
              <span className="font-medium text-red-500">
                Tombstoned - permanently removed from the validator set.
              </span>
            ) : (
              <span className="text-foreground">
                Jailed{" "}
                <span className="font-medium">
                  {jailings === 1 ? "once" : `${jailings} times`}
                </span>{" "}
                since {window}.
              </span>
            )}
          </div>

          <table className="gata-table w-full text-sm sm:min-w-[520px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground">
                  Event
                </th>
                <th className="px-4 py-3 font-medium text-muted-foreground">
                  Reason
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Burned
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Height
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Date
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={`${e.height}-${e.kind}`}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="px-4 py-3">
                    <EventLabel kind={e.kind} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {reasonLabel(e.reason)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {e.burned ? (
                      <>
                        {formatToken(e.burned, chain.exponent, 2)}{" "}
                        <span className="text-muted-foreground">{symbol}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {e.height.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground whitespace-nowrap">
                    {new Date(e.time).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The covered window stays — without it "never jailed" overclaims — but
          the explanation of why does not. */}
      <p className="mt-2 text-xs text-muted-foreground">covering {window} onwards</p>
    </>
  );
}

const LABELS: Record<SlashKind, { text: string; className: string }> = {
  jailed: { text: "Jailed", className: "text-amber-500" },
  unjailed: { text: "Unjailed", className: "text-emerald-500" },
  slashed: { text: "Slashed", className: "text-red-500" },
  tombstoned: { text: "Tombstoned", className: "text-red-500 font-medium" },
};

function EventLabel({ kind }: { kind: SlashKind }) {
  const label = LABELS[kind];
  return <span className={label.className}>{label.text}</span>;
}

function reasonLabel(reason: string | null): string {
  if (reason === "downtime") return "Missed blocks";
  if (reason === "double_sign") return "Double signing";
  return "-";
}
