import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getChain, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import type { LinkedAddress } from "@/lib/bech32";
import { truncateMiddle } from "@/lib/format";

/**
 * When an address is unused here, check whether the same key is active on any
 * of the linked chains. A bech32 address is valid on every chain, so landing on
 * an empty page usually means the right key on the wrong chain.
 */
export async function AddressElsewhere({
  links,
  currentChainId,
}: {
  links: LinkedAddress[];
  currentChainId: string;
}) {
  const others = links.filter((l) => l.chainId !== currentChainId);
  if (others.length === 0) return null;

  const found = (
    await Promise.all(
      others.map(async (link) => {
        const chain = getChain(link.chainId);
        if (!chain) return null;
        try {
          const account = await getAdapter(chain).getAccount(link.address);
          return account.exists ? { link, chain } : null;
        } catch {
          return null;
        }
      })
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);

  if (found.length === 0) return null;

  return (
    <div className="mt-5">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        This account is active elsewhere
      </h2>
      <ul className="space-y-2">
        {found.map(({ link, chain }) => (
          <li key={link.chainId}>
            <Link
              href={`/${link.chainId}/accounts/${link.address}`}
              className="gata-panel gata-panel-interactive flex items-center justify-between gap-3 px-5 py-4"
              style={{ ["--panel-accent" as string]: accentFor(chain) }}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: accentFor(chain) }}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{chain.prettyName}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {truncateMiddle(link.address, 14, 8)}
                  </span>
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
