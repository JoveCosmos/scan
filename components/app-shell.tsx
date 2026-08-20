"use client";

import { usePathname } from "next/navigation";
import { SideRail } from "@/components/side-rail";
import { SiteHeader, type ChainSummary } from "@/components/site-header";

/**
 * Holds the rail and the column beside it.
 *
 * This exists for one reason: the rail is chain-scoped and the landing page has
 * no chain, so on that page there is no rail and the column must not be indented
 * past one that is not there. Which page we are on is a client fact, and the
 * root layout is a server component, so the decision lives here.
 *
 * The padding matches the rail's width exactly. Because the rail is `fixed` it
 * escapes this element, so the header, the content and the footer all shift
 * together and stay centred in the same space — a rail outside the flow with
 * only the content indented would leave the header 32px off from everything
 * under it.
 */
export function AppShell({
  chains,
  footer,
  children,
}: {
  chains: ChainSummary[];
  /** Passed through from the server layout so it is not dragged client-side. */
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const hasChain = chains.some((c) => c.chainId === pathname.split("/")[1]);

  return (
    <>
      <SideRail chains={chains} />
      <div
        className={`flex min-h-screen flex-col ${hasChain ? "pl-14 sm:pl-16" : ""}`}
      >
        <SiteHeader chains={chains} />
        <div className="flex-1">{children}</div>
        {footer}
      </div>
    </>
  );
}
