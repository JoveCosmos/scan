import type { ChainConfig } from "@/lib/chains";
import { accentFor, symbolFor } from "@/lib/chains";
import { stakeHistory } from "@/lib/indexer-db";
import { formatToken } from "@/lib/overview";

const WIDTH = 640;
const HEIGHT = 72;

/**
 * Bonded stake over the last quarter.
 *
 * The 24h delta answers "did it move"; this answers "what has been happening" —
 * whether a validator has been steadily gaining delegations, bled them after a
 * jailing, or sat flat. validator_stake has held the snapshots all along and
 * nothing read them beyond that one subtraction.
 *
 * Drawn as an inline SVG rather than with a charting library: it is a polyline
 * over sixty points, and adding a dependency for that would cost more in bundle
 * than the feature is worth.
 *
 * The Y axis deliberately does not start at zero. Stake moves by a few percent
 * and a zero-based axis renders every validator as the same flat line — the
 * question here is the shape of the change, and the labelled ends carry the
 * absolute figures.
 */
export async function ValidatorStakeHistory({
  chain,
  operator,
}: {
  chain: ChainConfig;
  operator: string;
}) {
  // Logged rather than swallowed. A failing query and a validator with no
  // snapshots both render nothing, and the last feature that hid a SQL error
  // this way shipped broken — the log is the only thing that tells them apart.
  const points = await stakeHistory(chain.chainId, operator).catch((err) => {
    console.error(`stakeHistory failed for ${operator}:`, err);
    return null;
  });
  if (!points || points.length < 2) return null;

  const values = points.map((p) => Number(p.tokens));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * WIDTH;
    const y = HEIGHT - ((Number(p.tokens) - min) / span) * (HEIGHT - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const accent = accentFor(chain);
  const symbol = symbolFor(chain);
  const first = values[0];
  const last = values[values.length - 1];
  const change = first > 0 ? (last - first) / first : 0;
  const jailedAt = points
    .map((p, i) => (p.jailed ? i : -1))
    .filter((i) => i >= 0);

  return (
    <>
      <h2 className="mt-6 mb-3 text-sm font-medium text-muted-foreground">
        Stake history
      </h2>
      <div
        className="gata-panel px-5 py-4"
        style={{ ["--panel-accent" as string]: accent }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-mono text-lg font-semibold leading-none">
            {formatToken(String(Math.round(last)), chain.exponent, 2)}{" "}
            <span className="text-xs font-normal text-muted-foreground">{symbol}</span>
          </span>
          <span
            className={
              change >= 0
                ? "font-mono text-sm text-[var(--gata-green)]"
                : "font-mono text-sm text-[var(--gata-burn)]"
            }
          >
            {change >= 0 ? "+" : ""}
            {(change * 100).toFixed(2)}%
          </span>
        </div>

        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="mt-3 h-[72px] w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Bonded stake over the last 90 days, ${
            change >= 0 ? "up" : "down"
          } ${Math.abs(change * 100).toFixed(1)} percent`}
        >
          {/* Fill first so the line sits on top of it. */}
          <polygon
            points={`0,${HEIGHT} ${coords.join(" ")} ${WIDTH},${HEIGHT}`}
            fill={accent}
            opacity={0.12}
          />
          <polyline
            points={coords.join(" ")}
            fill="none"
            stroke={accent}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          {/* A jailing is the one event that explains a cliff, so it is marked. */}
          {jailedAt.map((i) => (
            <circle
              key={i}
              cx={(i / (points.length - 1)) * WIDTH}
              cy={
                HEIGHT - ((values[i] - min) / span) * (HEIGHT - 8) - 4
              }
              r={2.5}
              fill="var(--gata-burn)"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>{new Date(points[0].time).toLocaleDateString()}</span>
          <span>90 days</span>
          <span>{new Date(points[points.length - 1].time).toLocaleDateString()}</span>
        </div>
      </div>
    </>
  );
}
