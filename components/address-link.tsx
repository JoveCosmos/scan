import Link from "next/link";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * An on-chain address, always clickable.
 *
 * Validator operator addresses (`…valoper1…`) route to the validator page;
 * everything else to the account page. Centralised so no address anywhere in
 * the app ends up as dead text.
 */
export function AddressLink({
  chainId,
  address,
  label,
  className,
  head = 12,
  tail = 6,
}: {
  chainId: string;
  address: string | null | undefined;
  /** Shown instead of the truncated address — a validator moniker, say. */
  label?: string | null;
  className?: string;
  head?: number;
  tail?: number;
}) {
  if (!address) return <span className="text-muted-foreground">—</span>;

  const isValidator = /valoper1/.test(address);
  const href = isValidator
    ? `/${chainId}/validators/${address}`
    : `/${chainId}/accounts/${address}`;

  return (
    <Link
      href={href}
      title={address}
      className={cn(
        "text-primary hover:underline",
        !label && "font-mono text-xs",
        className
      )}
    >
      {label ?? truncateMiddle(address, head, tail)}
    </Link>
  );
}
