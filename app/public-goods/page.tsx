import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getChain, accentFor } from "@/lib/chains";
import { servedChainIds, servicesFor } from "@/lib/services";

export const metadata: Metadata = {
  // The layout appends the site name, so repeating it here reads as a stutter.
  title: "Public goods",
  description:
    "Public endpoints and snapshots operated by GATA HUB for the networks it validates.",
};

export const revalidate = 300;

/**
 * A network picker, not a combined list.
 *
 * The detail lives at /[chain]/nodes, per network, the way the rest of the
 * explorer is organised — someone setting up an AtomOne node does not want
 * gno.land's endpoints between them and the one they need. This page exists so
 * the landing button has somewhere to go without having to pick a default
 * chain on the user's behalf.
 */
export default function PublicGoodsPage() {
  const chains = servedChainIds()
    .map((id) => ({ id, chain: getChain(id) }))
    .filter((c): c is { id: string; chain: NonNullable<typeof c.chain> } =>
      Boolean(c.chain)
    );

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <h1 className="mt-4 text-2xl font-medium">Public goods</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Endpoints and snapshots we run for the networks we validate on. Pick a
        network.
      </p>

      {chains.length === 0 ? (
        <div className="gata-panel mt-8 px-5 py-10 text-center">
          <p className="text-sm text-muted-foreground">Nothing published yet.</p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {chains.map(({ id, chain }) => {
            const accent = accentFor(chain);
            const count = servicesFor(id)?.endpoints.length ?? 0;
            return (
              <li key={id}>
                <Link
                  href={`/${id}/nodes`}
                  className="gata-panel gata-panel-interactive flex items-center justify-between px-5 py-4 transition-colors hover:border-[var(--gata-border-hi)]"
                  style={{ ["--panel-accent" as string]: accent }}
                >
                  <span className="flex items-center gap-3">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">{chain.prettyName}</span>
                      <span className="text-xs text-muted-foreground">
                        {count} {count === 1 ? "endpoint" : "endpoints"}
                      </span>
                    </span>
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
