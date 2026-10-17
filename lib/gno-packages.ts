import type { ChainConfig } from "@/lib/chains";
import { packageHref } from "@/lib/address-route";
import { cached } from "@/lib/cache";
import { hashedAddress } from "@/lib/hashed-address";
import { abciQuery } from "@/lib/gno-abci";
import { gnoIndexed, indexedCalls, indexedCallStats, indexedDeploys } from "@/lib/gno-index";
import { coverageOf } from "@/lib/indexer-coverage";
import { indexerPool } from "@/lib/indexer-db";

/**
 * gno.land's code on chain: realms (gno.land/r/…, stateful, callable) and
 * packages (gno.land/p/…, pure libraries).
 *
 * The node is the truth for what exists and what it contains (vm/qpaths,
 * vm/qfile, vm/qfuncs, vm/qdoc, vm/qstorage, vm/qrender); a package the node
 * rejected is not there even if its deploy succeeded. Our index (gno_tx_msg)
 * says who deployed each one, when, and who has called a realm since.
 */

/** A package path as gno.land writes it: gno.land/r/… or gno.land/p/…. */
const PKG_PATH = /^gno\.land\/[rp](\/[a-z0-9_][a-z0-9_.-]*)+$/;

export function isPackagePath(path: string): boolean {
  return PKG_PATH.test(path);
}

export { packageHref };

/** "gno.land/r/g1abc…xyz/app": the domain off, a namespace address shortened. */
export function shortPath(path: string): string {
  return path
    .replace(/^gno\.land\//, "")
    .split("/")
    .map((s) => (/^g1[a-z0-9]{38}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s))
    .join("/");
}

export const isRealm = (path: string) => path.startsWith("gno.land/r/");

/** One vm/* query; see abciQuery for what `missing` means. */
const vmQuery = (chain: ChainConfig, path: string, data: string, timeoutMs = 8000) =>
  abciQuery(chain, path, data, timeoutMs);

/** Every package path on the chain, sorted. Null when no node answered. */
export function gnoPackagePaths(chain: ChainConfig): Promise<string[] | null> {
  return cached(
    `gno-paths:${chain.chainId}`,
    5 * 60_000,
    async () => {
      const r = await vmQuery(chain, "vm/qpaths", "gno.land/", 15_000);
      if (!r.ok) throw new Error("qpaths unavailable");
      return r.data
        .split("\n")
        .map((p) => p.trim())
        .filter(isPackagePath)
        .sort();
    },
    { staleMs: 24 * 60 * 60_000 }
  ).catch(() => null);
}

/**
 * A realm's own account address: the first 20 bytes of
 * sha256("pkgPath:" + path), as gno derives it.
 */
export function realmAddress(path: string): string {
  return hashedAddress("g", `pkgPath:${path}`);
}

/** Every realm's account address to its path. Null when no node answered. */
export async function realmByAddress(chain: ChainConfig): Promise<Map<string, string> | null> {
  const paths = await gnoPackagePaths(chain);
  if (!paths) return null;
  return cached(`gno-realm-addrs:${chain.chainId}:${paths.length}`, 24 * 60 * 60_000, async () => {
    const map = new Map<string, string>();
    for (const p of paths) if (isRealm(p)) map.set(realmAddress(p), p);
    return map;
  });
}

export interface GnoDeploy {
  path: string;
  creator: string;
  height: number;
  /** Uppercase hex. */
  txHash: string;
  /** Block time, from the index; null where it has none. */
  time: string | null;
}

/**
 * Who deployed each package: every successful MsgAddPackage in our index
 * (gno_tx_msg, migration 014), the first deploy of a path winning. One query
 * for the whole chain. Null until the index covers every message.
 */
export function gnoDeploys(chain: ChainConfig): Promise<Map<string, GnoDeploy> | null> {
  return cached(
    `gno-deploys:${chain.chainId}`,
    10 * 60_000,
    async () => {
      const pool = await gnoIndexed(chain.chainId, "gno_tx_msg");
      if (!pool) return null;
      const rows = await indexedDeploys(pool, chain.chainId);
      return new Map(
        [...rows].map(([path, d]) => [path, { path, creator: d.creator, height: d.height, txHash: d.txHash, time: d.time }])
      );
    },
    { staleMs: 24 * 60 * 60_000 }
  ).catch(() => null);
}

/** Block times of gno transactions by hex hash, from gno_tx. Empty without the index. */
export async function gnoTxTimes(chainId: string, hashes: string[]): Promise<Map<string, string>> {
  const pool = indexerPool();
  if (!pool || hashes.length === 0) return new Map();
  if (!(await coverageOf(chainId, "gno_tx").catch(() => null))) return new Map();
  try {
    const { rows } = await pool.query<{ hash: string; time: string }>(
      `SELECT hash, time::text AS time FROM gno_tx WHERE chain_id = $1 AND hash = ANY($2::text[]) AND time IS NOT NULL`,
      [chainId, hashes]
    );
    return new Map(rows.map((r) => [r.hash, r.time]));
  } catch {
    return new Map();
  }
}

export interface GnoPackage {
  path: string;
  /** File names, as the node lists them. */
  files: string[];
}

/**
 * A package's file list. Null when the node says there is no such package;
 * throws when no node answered, so the page can tell the two apart.
 */
export function gnoPackage(chain: ChainConfig, path: string): Promise<GnoPackage | null> {
  return cached(
    `gno-pkg:${chain.chainId}:${path}`,
    60 * 60_000,
    async () => {
      const r = await vmQuery(chain, "vm/qfile", path);
      if (!r.ok) {
        if (r.missing) return null;
        throw new Error("node unavailable");
      }
      const files = r.data
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
      return { path, files };
    },
    { group: { name: "gno-pkg", max: 200 } }
  );
}

/** Files at most this large are shown whole; larger ones are cut there. */
const MAX_FILE = 200_000;

/**
 * The source of every file in a package. Deployed code never changes, so it
 * is kept for a day, a few dozen packages at a time.
 */
export function gnoSources(chain: ChainConfig, pkg: GnoPackage): Promise<{ name: string; source: string | null }[]> {
  return cached(
    `gno-src:${chain.chainId}:${pkg.path}`,
    24 * 60 * 60_000,
    async () =>
      Promise.all(
        pkg.files.slice(0, 60).map(async (name) => {
          const r = await vmQuery(chain, "vm/qfile", `${pkg.path}/${name}`);
          return { name, source: r.ok ? r.data.slice(0, MAX_FILE) : null };
        })
      ),
    { group: { name: "gno-src", max: 30 } }
  );
}

export interface GnoFunc {
  name: string;
  params: { name: string; type: string }[];
  results: string[];
}

/** The type gno prints for `realm`, the implicit first parameter of a crossing function. */
const REALM_TYPE = /^interface \{\.seal func\(\);/;
const ERROR_TYPE = "interface {Error func() string}";

/** A package's exported functions, from vm/qfuncs. Null when unavailable. */
export function gnoFuncs(chain: ChainConfig, path: string): Promise<GnoFunc[] | null> {
  return cached(
    `gno-funcs:${chain.chainId}:${path}`,
    24 * 60 * 60_000,
    async () => {
      const r = await vmQuery(chain, "vm/qfuncs", path);
      if (!r.ok) return null;
      const raw = JSON.parse(r.data) as {
        FuncName: string;
        Params: { Name: string; Type: string }[] | null;
        Results: { Name: string; Type: string }[] | null;
      }[];
      // Types as the source writes them: the package's own without its path,
      // the error interface as "error".
      const own = `${path}.`;
      const type = (t: string) =>
        REALM_TYPE.test(t) ? "realm" : t === ERROR_TYPE ? "error" : t.split(own).join("");
      return raw.map((f) => ({
        name: f.FuncName,
        params: (f.Params ?? []).map((p) => ({ name: p.Name, type: type(p.Type) })),
        results: (f.Results ?? []).map((x) => type(x.Type)),
      }));
    },
    { group: { name: "gno-funcs", max: 200 } }
  ).catch(() => null);
}

/** A package's doc comment, from vm/qdoc. Null when it has none. */
export function gnoDoc(chain: ChainConfig, path: string): Promise<string | null> {
  return cached(
    `gno-doc:${chain.chainId}:${path}`,
    24 * 60 * 60_000,
    async () => {
      const r = await vmQuery(chain, "vm/qdoc", path);
      if (!r.ok) return null;
      const doc = (JSON.parse(r.data) as { package_doc?: string }).package_doc?.trim();
      return doc || null;
    },
    { group: { name: "gno-doc", max: 200 } }
  ).catch(() => null);
}

/** Bytes a realm keeps in state and the deposit locked for them (base units). */
export function gnoStorage(chain: ChainConfig, path: string): Promise<{ bytes: number; deposit: string } | null> {
  return cached(
    `gno-storage:${chain.chainId}:${path}`,
    10 * 60_000,
    async () => {
      const r = await vmQuery(chain, "vm/qstorage", path);
      const m = r.ok ? r.data.match(/storage:\s*(\d+),\s*deposit:\s*(\d+)/) : null;
      return m ? { bytes: Number(m[1]), deposit: m[2] } : null;
    },
    { group: { name: "gno-storage", max: 200 } }
  ).catch(() => null);
}

/** A realm's Render(args) output, Markdown. Null when it has none. */
export function gnoRender(chain: ChainConfig, path: string, args = ""): Promise<string | null> {
  return cached(
    `gno-render:${chain.chainId}:${path}:${args}`,
    2 * 60_000,
    async () => {
      const r = await vmQuery(chain, "vm/qrender", `${path}:${args}`);
      return r.ok && r.data.trim() ? r.data : null;
    },
    { group: { name: "gno-render", max: 50 } }
  ).catch(() => null);
}

export interface GnoCall {
  /** Uppercase hex. */
  txHash: string;
  height: number;
  success: boolean;
  caller: string;
  func: string;
  time: string | null;
  /** The call's arguments, where our index has them (each cut at 200 characters). */
  args?: string[] | null;
}

/** Calls on one page of a realm's Calls tab. */
export const CALLS_PAGE = 100;

/**
 * Calls made to a realm (MsgCall) from our index (gno_tx_msg, migration 014):
 * the newest page with its keyset cursor (`next`), the total and the distinct
 * callers. Null until the index covers every message.
 */
export async function gnoRealmCalls(
  chain: ChainConfig,
  path: string
): Promise<{ calls: GnoCall[]; total: number; callers: number; next: string | null } | null> {
  const pool = await gnoIndexed(chain.chainId, "gno_tx_msg");
  if (!pool) return null;
  try {
    const [stats, page] = await Promise.all([
      indexedCallStats(pool, chain.chainId, path),
      indexedCalls(pool, chain.chainId, path, CALLS_PAGE),
    ]);
    return { calls: page.calls, total: stats.total, callers: stats.callers, next: page.next };
  } catch {
    return null;
  }
}
