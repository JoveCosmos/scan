import Link from "next/link";
import { getAllChains, type ChainConfig } from "@/lib/chains";
import { convertAddress } from "@/lib/bech32";
import { getValidatorsCached, getInactiveValidators, type ValidatorSummary } from "@/lib/validators";

/** Longest a slow chain may hold this strip up; it streams, so it never blocks. */
const PER_CHAIN_MS = 4000;

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/**
 * The same operator validating on our other networks, linked to its validator
 * page there. Matched by key first — the account behind the operator address
 * re-encoded under each chain's prefix — then by the Keybase identity it
 * publishes, which catches operators who use a different key per chain.
 */
export async function ValidatorElsewhere({
  chain,
  account,
  identity,
}: {
  chain: ChainConfig;
  /** The validator's own account (self-delegation) address. */
  account: string | null;
  identity: string;
}) {
  const others = getAllChains().filter((c) => c.kind === "cosmos" && c.chainId !== chain.chainId);

  const found = await Promise.all(
    others.map(async (c) => {
      const sets = await within(
        Promise.all([
          getValidatorsCached(c).catch(() => [] as ValidatorSummary[]),
          getInactiveValidators(c).catch(() => [] as ValidatorSummary[]),
        ]).then(([a, b]) => [...a, ...b]),
        PER_CHAIN_MS,
        [] as ValidatorSummary[]
      );
      const byKey = account ? convertAddress(account, `${c.bech32Prefix}valoper`) : null;
      const hit =
        (byKey && sets.find((v) => v.operatorAddress === byKey)) ||
        (identity.trim() && sets.find((v) => v.identity && v.identity === identity.trim())) ||
        null;
      return hit ? { chain: c, operator: hit.operatorAddress } : null;
    })
  );

  const hits = found.filter((f): f is { chain: ChainConfig; operator: string } => f !== null);
  if (hits.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        Also validates
      </span>
      <div className="flex flex-wrap gap-1.5 text-[12px]">
        {hits.map((h) => (
          <Link
            key={h.chain.chainId}
            href={`/${h.chain.chainId}/validators/${h.operator}`}
            className="rounded-md border border-border bg-[var(--gata-card)] px-2 py-0.5 text-primary transition-colors hover:border-[var(--gata-border-hi)]"
          >
            {h.chain.prettyName}
          </Link>
        ))}
      </div>
    </div>
  );
}
