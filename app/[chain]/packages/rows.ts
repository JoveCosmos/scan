import type { DeckColumn, DeckRow } from "@/components/row-deck";
import type { ChainConfig } from "@/lib/chains";
import {
  gnoDeploys,
  gnoPackagePaths,
  isRealm,
  packageHref,
  shortPath,
  type GnoCall,
  type GnoDeploy,
} from "@/lib/gno-packages";
import { withinBudget } from "@/lib/cache";
import { formatDate, timeAgo, truncateMiddle } from "@/lib/format";
import { addressCell, atName, gnoNames, type GnoNames } from "@/lib/gno-users";

/** A realm's Calls tab: the page's first rows and each older page from the API. */
export const CALL_COLUMNS: DeckColumn[] = [
  { label: "Function", width: "24%" },
  { label: "Caller" },
  { label: "Status", width: "11%", phoneHide: true },
  { label: "Block", align: "right", width: "12%", optional: true },
  { label: "Age", align: "right", width: "12%" },
];

export function callRows(chainId: string, calls: GnoCall[], names: GnoNames | null = null): DeckRow[] {
  return calls.map((c, i) => ({
    key: `${c.txHash}-${c.func}-${i}`,
    search: `${c.func} ${c.caller} ${names?.byAddress.get(c.caller) ?? ""}`,
    cells: [
      { v: c.func, mono: true, tone: "accent" },
      addressCell(names, c.caller),
      { v: c.success ? "Success" : "Failed", tone: c.success ? "ok" : "bad" },
      { v: c.height.toLocaleString(), mono: true, align: "right", href: `/${chainId}/blocks/${c.height}` },
      { v: c.time ? timeAgo(c.time) : "-", dim: true, align: "right" },
    ],
    detail: {
      title: c.func,
      sub: truncateMiddle(c.txHash, 10, 8),
      // Arguments where our index has them.
      rows: (c.args ?? []).map((a, n) => ({ label: `Argument ${n + 1}`, value: a, mono: true })),
      action: { label: "Transaction", href: `/${chainId}/txs/${c.txHash}` },
    },
  }));
}

// ── The package list ─────────────────────────────────────────────────────────

export const PACKAGE_COLUMNS: DeckColumn[] = [
  { label: "Path" },
  { label: "Deployer", width: "22%", phoneHide: true },
  { label: "Block", align: "right", width: "12%", phoneWidth: "26%" },
  { label: "Deployed", align: "right", width: "14%", optional: true },
];

export interface PackageList {
  /** Null when no node answered. */
  paths: string[] | null;
  realms: { path: string; deploy: GnoDeploy | null }[];
  libs: { path: string; deploy: GnoDeploy | null }[];
  deployers: number | null;
  names: GnoNames | null;
}

/** Every realm and package, newest deploy first, genesis ones by path after. */
export async function loadPackageList(chain: ChainConfig): Promise<PackageList> {
  const [paths, deploys, names] = await Promise.all([
    gnoPackagePaths(chain),
    withinBudget(gnoDeploys(chain), 8000, null),
    withinBudget(gnoNames(chain), 1500, null),
  ]);
  const all = (paths ?? []).map((path) => ({ path, deploy: deploys?.get(path) ?? null }));
  all.sort((a, b) => (b.deploy?.height ?? -1) - (a.deploy?.height ?? -1) || a.path.localeCompare(b.path));
  return {
    paths,
    realms: all.filter((r) => isRealm(r.path)),
    libs: all.filter((r) => !isRealm(r.path)),
    deployers: deploys ? new Set(all.flatMap((r) => (r.deploy ? [r.deploy.creator] : []))).size : null,
    names,
  };
}

export function packageRows(
  chainId: string,
  list: { path: string; deploy: GnoDeploy | null }[],
  names: GnoNames | null
): DeckRow[] {
  return list.map(({ path, deploy }) => ({
    key: path,
    search: `${path} ${deploy?.creator ?? ""} ${atName(names, deploy?.creator) ?? ""}`,
    cells: [
      { v: shortPath(path), mono: true, href: packageHref(chainId, path) },
      deploy?.creator ? addressCell(names, deploy.creator) : { v: "-", dim: true },
      deploy
        ? deploy.height === 0
          ? { v: "Genesis", dim: true, align: "right" }
          : { v: deploy.height.toLocaleString(), mono: true, align: "right", href: `/${chainId}/blocks/${deploy.height}` }
        : { v: "-", dim: true, align: "right" },
      { v: deploy?.height === 0 ? "-" : formatDate(deploy?.time ?? null), dim: true, align: "right" },
    ],
    detail: {
      title: shortPath(path),
      rows: [],
      action: { label: isRealm(path) ? "Realm" : "Package", href: packageHref(chainId, path) },
    },
  }));
}
