"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { routeAddress } from "@/lib/address-route";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useChainDirectory } from "@/components/providers/chain-directory";

/**
 * An on-chain address, always clickable when we carry its chain.
 *
 * Routing is lib/address-route's: operator and consensus addresses go to the
 * validator page, a foreign prefix goes to its own chain, and an address no
 * chain of ours uses stays plain text rather than linking to an empty page.
 * The current chain is read from the URL, so callers pass only the address.
 */
export function AddressLink({
  address,
  label,
  className,
  head = 12,
  tail = 6,
  full = false,
}: {
  address: string | null | undefined;
  /** Shown instead of the address - a validator moniker, say. */
  label?: string | null;
  className?: string;
  head?: number;
  tail?: number;
  /** Show the whole address instead of truncating it. */
  full?: boolean;
}) {
  const chains = useChainDirectory();
  const current = usePathname().split("/")[1] ?? null;
  if (!address) return <span className="text-muted-foreground">-</span>;

  const route = routeAddress(address, current, chains);
  const text = label ?? (full ? address : truncateMiddle(address, head, tail));
  if (!route) {
    return (
      <span title={address} className={cn(!label && "font-mono", className)}>
        {text}
      </span>
    );
  }

  return (
    <Link
      href={route.href}
      title={address}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "text-primary underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current",
        !label && "font-mono",
        className
      )}
    >
      {text}
    </Link>
  );
}
