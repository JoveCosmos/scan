"use client";

import { createContext, useContext } from "react";
import type { ChainPrefix } from "@/lib/address-route";

/**
 * The chains' address prefixes, available to every client component so an
 * address can be routed without a server round trip. Provided once by
 * AppShell from the layout's chain list.
 */
const ChainDirectoryContext = createContext<readonly ChainPrefix[]>([]);

export function ChainDirectoryProvider({
  chains,
  children,
}: {
  chains: readonly ChainPrefix[];
  children: React.ReactNode;
}) {
  return (
    <ChainDirectoryContext.Provider value={chains}>{children}</ChainDirectoryContext.Provider>
  );
}

export function useChainDirectory(): readonly ChainPrefix[] {
  return useContext(ChainDirectoryContext);
}
