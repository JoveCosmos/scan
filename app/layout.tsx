import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/providers/query-provider";
import { SiteHeader } from "@/components/site-header";
import { getAllChains, symbolFor, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono-family",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "GATA HUB Explorer",
    template: "%s · GATA HUB Explorer",
  },
  description:
    "Multi-chain Cosmos block explorer by GATA HUB - Cosmos Hub, AtomOne and Akash.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const chains = getAllChains().map((chain) => ({
    chainId: chain.chainId,
    prettyName: chain.prettyName,
    symbol: symbolFor(chain),
    accent: accentFor(chain),
    governance: getAdapter(chain).capabilities.governance,
    network: chain.network,
  }));

  return (
    // Font variables live on <html> because globals.css applies `font-sans`
    // there; defining them only on <body> leaves the html rule unresolved.
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased">
        {/* Fixed ambient grid, masked to the top of the viewport. */}
        <div
          aria-hidden="true"
          className="gata-grid-lines pointer-events-none fixed inset-0 -z-10"
        />
        <QueryProvider>
          <div className="flex min-h-screen flex-col">
            <SiteHeader chains={chains} />
            <div className="flex-1">{children}</div>
            <footer className="mt-16 border-t border-border">
              <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span>
                  <span className="font-semibold text-foreground">GATA HUB</span>{" "}
                  Explorer
                </span>
              </div>
            </footer>
          </div>
        </QueryProvider>
      </body>
    </html>
  );
}
