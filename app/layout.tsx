import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Sora } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/providers/query-provider";
import { AppShell } from "@/components/app-shell";
import { getAllChains, symbolFor, accentFor, logoFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { policyFor } from "@/lib/tiers";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

// Display face for titles, tabs and headline figures; Inter stays for text.
const sora = Sora({
  variable: "--font-display-family",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono-family",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "GATA SCAN",
    template: "%s, GATA SCAN",
  },
  description:
    "Multi-chain Cosmos block scan by GATA HUB - Cosmos Hub, AtomOne and Akash.",
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
    logo: logoFor(chain),
    accent: accentFor(chain),
    // gno.land's governance is a realm (GovDAO), read by the proposals pages.
    governance: getAdapter(chain).capabilities.governance || chain.kind === "gno",
    // gno.land has no IBC module; every Cosmos SDK chain here does.
    ibc: chain.kind === "cosmos",
    network: chain.network,
    bech32Prefix: chain.bech32Prefix,
    sections: (({ txs, proposals, relayers }) => ({ txs, proposals, relayers }))(
      policyFor(chain)
    ),
  }));

  return (
    // Font variables live on <html> because globals.css applies `font-sans`
    // there; defining them only on <body> leaves the html rule unresolved.
    // suppressHydrationWarning: the theme script below stamps data-theme on
    // this element before React hydrates it.
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${sora.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies a saved day/night choice before first paint. Kept inline
            and tiny: anything loaded later would flash the other theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("gata-scan-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body className="antialiased">
        {/* Fixed ambient grid, masked to the top of the viewport. */}
        <div
          aria-hidden="true"
          className="gata-grid-lines pointer-events-none fixed inset-0 -z-10"
        />
        <QueryProvider>
          <AppShell
            chains={chains}
            footer={
              <footer className="shrink-0 border-t border-border">
                {/*
                  Attribution, not a title, and now a single line: with the app
                  pinned to the viewport every row the footer takes is a row the
                  page does not get.
                */}
                <div className="mx-auto flex h-8 max-w-[90rem] items-center justify-end px-4 text-[11px] text-muted-foreground">
                  <span>
                    powered by{" "}
                    <a
                      href="https://gatahub.zone"
                      className="font-medium text-foreground transition-colors hover:text-[var(--gata-blue)]"
                    >
                      GATA HUB
                    </a>
                  </span>
                </div>
              </footer>
            }
          >
            {children}
          </AppShell>
        </QueryProvider>
      </body>
    </html>
  );
}
