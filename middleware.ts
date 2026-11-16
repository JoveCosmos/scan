import { NextResponse, type NextRequest } from "next/server";

/**
 * Real 404s for addresses that cannot exist, decided before anything renders.
 *
 * Chain pages stream behind a loading screen, so by the time a page finds out
 * its block or transaction is missing the 200 has already been sent (it then
 * marks itself noindex). That is right for a well-formed hash nobody has seen;
 * an unknown chain or a malformed id can be told from the URL alone, and gets a
 * proper status here: link checkers and crawlers stop following it. Redirects
 * (chain short names, retired testnets) run before this.
 */

/** Chain id to the sections only some chains have (see next.config.ts). */
const CHAINS = new Map(
  (process.env.SCAN_CHAIN_SECTIONS ?? "")
    .split(";")
    .filter(Boolean)
    .map((entry) => {
      const [id, extra = ""] = entry.split(":");
      return [id, new Set(extra.split(",").filter(Boolean))] as const;
    })
);

/** Sections every chain has. */
const SECTIONS = new Set(["params", "validators", "proposals", "blocks", "txs", "accounts"]);

const BECH32 = /^[a-z0-9]{1,83}1[02-9ac-hj-np-z]{6,}$/i;

/** What a section's id must look like, where it has one. */
const ID: Record<string, RegExp> = {
  blocks: /^\d{1,15}$/,
  proposals: /^\d{1,12}$/,
  // Cosmos: 64 hex. gno.land: base64 (44 chars), or its hex form.
  txs: /^([0-9A-Fa-f]{64}|[A-Za-z0-9+/_=-]{43,44})$/,
  validators: BECH32,
  accounts: BECH32,
  governors: BECH32,
  // gno.land: /packages/r/… or /packages/p/…, "gno.land/" optional.
  packages: /^(r|p|gno\.land)$/,
  // gno.land GRC20: /tokens/r/<realm>/<SYMBOL>.
  tokens: /^(r|gno\.land)$/,
};

function notFound(req: NextRequest) {
  // A path no route serves (deeper than any: /[chain]/x/[id]/y is the
  // deepest), so Next answers with its not-found page and a 404 status.
  return NextResponse.rewrite(new URL("/_404/_/_/_/_/_", req.url));
}

export function middleware(req: NextRequest) {
  if (CHAINS.size === 0) return NextResponse.next();
  const [, chain, section, id] = req.nextUrl.pathname.split("/");
  if (!chain) return NextResponse.next();
  if (!CHAINS.has(chain)) return notFound(req);
  if (!section) return NextResponse.next();
  if (!SECTIONS.has(section) && !CHAINS.get(chain)?.has(section)) return notFound(req);
  if (id !== undefined && ID[section]) {
    let value = id;
    try {
      value = decodeURIComponent(id);
    } catch {
      return notFound(req);
    }
    if (!ID[section].test(value)) return notFound(req);
  }
  return NextResponse.next();
}

export const config = {
  // Chain pages only: not the home page, search, API routes, Next's assets or
  // files in public/ (anything with an extension).
  matcher: ["/((?!_next/|api/|search|_404/|.*\\.[A-Za-z0-9]+$).+)"],
};
