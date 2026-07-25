import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/providers/query-provider";
import { SiteHeader } from "@/components/site-header";
import { getAllChains, symbolFor } from "@/lib/chains";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cosmos Explorer",
  description: "Multi-chain Cosmos block explorer",
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
  }));

  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <QueryProvider>
          <SiteHeader chains={chains} />
          {children}
          <footer className="mt-16 border-t border-border py-6">
            <div className="mx-auto max-w-6xl px-4 text-xs text-muted-foreground">
              Data served directly from public full nodes. No indexer.
            </div>
          </footer>
        </QueryProvider>
      </body>
    </html>
  );
}
