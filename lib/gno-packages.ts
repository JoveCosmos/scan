import { createHash } from "node:crypto";
import { bech32 } from "bech32";
import type { ChainConfig } from "@/lib/chains";
import { packageHref } from "@/lib/address-route";
import { cached } from "@/lib/cache";
import { gnoHashToHex, gql } from "@/lib/gno";
import { coverageOf } from "@/lib/indexer-coverage";
import { indexerPool } from "@/lib/indexer-db";

/**
 * gno.land's code on chain: realms (gno.land/r/…, stateful, callable) and
 * packages (gno.land/p/…, pure libraries).
 *
 * The node is the truth for what exists and what it contains (vm/qpaths,
 * vm/qfile, vm/qfuncs, vm/qdoc, vm/qstorage, vm/qrender); a package the node
 * rejected is not there even if its deploy succeeded. The tx-indexer says who
 * deployed each one, when, and who has called a realm since.
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

type VmResult = { ok: true; data: string } | { ok: false; missing: boolean };

/**
 * One vm/* query. `missing` tells "the node answered: no such package" from
 * "no node answered", so a page can 404 only on the first.
 */
async function vmQuery(chain: ChainConfig, path: string, data: string, timeoutMs = 8000): Promise<VmResult> {
  for (const endpoint of [...chain.rpcEndpoints, ...chain.fallbackRpcEndpoints]) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "abci_query",
          params: { path, data: Buffer.from(data).toString("base64") },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        error?: unknown;
        result?: { response?: { ResponseBase?: { Data?: string | null; Error?: unknown } } };
      };
      if (json.error) continue;
      const base = json.result?.response?.ResponseBase;
      if (!base) continue;
      if (base.Error) return { ok: false, missing: true };
      return { ok: true, data: Buffer.from(base.Data ?? "", "base64").toString() };
    } catch {
      continue;
    }
  }
  return { ok: false, missing: false };
}

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
  const bytes = createHash("sha256").update(`pkgPath:${path}`).digest().subarray(0, 20);
  return bech32.encode("g", bech32.toWords(bytes));
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

type DeployTx = {
  hash: string;
  block_height: number;
  success: boolean;
  messages: { value: { __typename: string; creator?: string; package?: { path: string } | null } | null }[];
};

/**
 * Who deployed each package, from the tx-indexer: every successful
 * MsgAddPackage, the first deploy of a path winning. One query for the
 * whole chain (the indexer scans every transaction for any message filter,
 * so per-package queries cost as much as this one), refreshed in the
 * background.
 */
export function gnoDeploys(chain: ChainConfig): Promise<Map<string, GnoDeploy> | null> {
  return cached(
    `gno-deploys:${chain.chainId}`,
    10 * 60_000,
    async () => {
      const data = await gql<{ getTransactions: DeployTx[] | null }>(
        chain,
        `{ getTransactions(where: { success: { eq: true }, messages: { value: { MsgAddPackage: { package: { path: { like: "gno.land/" } } } } } }, order: { heightAndIndex: ASC }) {
            hash block_height success
            messages { value { __typename ... on MsgAddPackage { creator package { path } } } }
          } }`,
        {},
        30_000
      );
      const byPath = new Map<string, GnoDeploy>();
      for (const tx of data.getTransactions ?? []) {
        if (!tx.success) continue;
        const txHash = gnoHashToHex(tx.hash);
        if (!txHash) continue;
        for (const m of tx.messages) {
          const path = m.value?.__typename === "MsgAddPackage" ? m.value.package?.path : null;
          if (!path || byPath.has(path)) continue;
          byPath.set(path, { path, creator: m.value!.creator ?? "", height: tx.block_height, txHash, time: null });
        }
      }
      const times = await gnoTxTimes(chain.chainId, [...new Set([...byPath.values()].map((d) => d.txHash))]);
      for (const d of byPath.values()) d.time = times.get(d.txHash) ?? null;
      return byPath;
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

/** A read-only expression evaluated by vm/qeval, e.g. `path.Func("x")`. Null on error. */
export async function gnoEval(chain: ChainConfig, expr: string): Promise<string | null> {
  const r = await vmQuery(chain, "vm/qeval", expr);
  return r.ok ? r.data : null;
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
}

type CallTx = {
  hash: string;
  block_height: number;
  success: boolean;
  messages: { value: { __typename: string; caller?: string; func?: string; pkg_path?: string } | null }[];
};

/** Calls kept per realm, newest first. */
const MAX_CALLS = 500;

/** The indexer returns at most this many transactions a query, silently or with an error. */
const INDEXER_CAP = 10_000;

/** MsgCall transactions to a realm in a height range; the lowest window has no lower bound (see gno-tokens). */
const callQuery = (bounded: boolean) => `query($p: String!, ${bounded ? "$a: Int!, " : ""}$b: Int!) {
  getTransactions(where: { block_height: { ${bounded ? "gt: $a, " : ""}lt: $b },
    messages: { value: { MsgCall: { pkg_path: { eq: $p } } } } }, order: { heightAndIndex: DESC }) {
    hash block_height success
    messages { value { __typename ... on MsgCall { caller func pkg_path } } }
  }
}`;

/**
 * Calls made to a realm (MsgCall), newest first, with the total. Read from
 * the chain's head down in height windows, each halved when it comes back
 * full, since the indexer caps a query at 10,000 transactions and a busy
 * realm has more. The indexer's message filter also returns transactions
 * with messages it cannot type, so each message's own package path is
 * checked here.
 */
export function gnoRealmCalls(
  chain: ChainConfig,
  path: string
): Promise<{ calls: GnoCall[]; total: number; callers: number } | null> {
  return cached(
    `gno-calls:${chain.chainId}:${path}`,
    2 * 60_000,
    async () => {
      const { latestBlockHeight: head } = await gql<{ latestBlockHeight: number }>(chain, "{ latestBlockHeight }");
      const shown: GnoCall[] = [];
      const callers = new Set<string>();
      let total = 0;
      let hi = head + 1;
      let window = 400_000;
      while (hi > 0) {
        const lo = Math.max(0, hi - window);
        const data = await gql<{ getTransactions: CallTx[] | null }>(
          chain,
          callQuery(lo > 0),
          lo > 0 ? { p: path, a: lo - 1, b: hi } : { p: path, b: hi },
          30_000
        );
        const txs = data.getTransactions ?? [];
        if (txs.length >= INDEXER_CAP && hi - lo > 1) {
          window = Math.max(1, Math.floor((hi - lo) / 2));
          continue;
        }
        for (const tx of txs) {
          const txHash = gnoHashToHex(tx.hash);
          if (!txHash) continue;
          for (const m of tx.messages) {
            const v = m.value;
            if (v?.__typename !== "MsgCall" || v.pkg_path !== path) continue;
            if (v.caller) callers.add(v.caller);
            total += 1;
            if (shown.length < MAX_CALLS) {
              shown.push({ txHash, height: tx.block_height, success: tx.success, caller: v.caller ?? "", func: v.func ?? "", time: null });
            }
          }
        }
        hi = lo;
        window = Math.min(window * 2, 400_000);
      }
      const times = await gnoTxTimes(chain.chainId, [...new Set(shown.map((c) => c.txHash))]);
      for (const c of shown) c.time = times.get(c.txHash) ?? null;
      return { calls: shown, total, callers: callers.size };
    },
    { staleMs: 30 * 60_000, group: { name: "gno-calls", max: 30 } }
  ).catch(() => null);
}
