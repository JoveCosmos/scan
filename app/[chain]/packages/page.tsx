import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { gnoDeploys, gnoPackagePaths, isRealm, packageHref, shortPath, type GnoDeploy } from "@/lib/gno-packages";
import { withinBudget } from "@/lib/cache";
import { formatDate, truncateMiddle } from "@/lib/format";
import { PageFrame } from "@/components/page-frame";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck, type DeckRow } from "@/components/row-deck";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} packages` : "Packages" };
}

const day = formatDate;

/**
 * gno.land's code: realms (stateful, callable) and packages (libraries),
 * newest first, with who deployed each.
 */
export default async function PackagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { chain: chainId } = await params;
  const { tab } = await searchParams;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") notFound();
  const accent = accentFor(chain);

  const [paths, deploys] = await Promise.all([
    gnoPackagePaths(chain),
    withinBudget(gnoDeploys(chain), 8000, null),
  ]);

  // Newest deploy first; genesis packages (height 0) by path after them.
  const rows = (paths ?? []).map((path) => ({ path, deploy: deploys?.get(path) ?? null }));
  rows.sort((a, b) => (b.deploy?.height ?? -1) - (a.deploy?.height ?? -1) || a.path.localeCompare(b.path));
  const realms = rows.filter((r) => isRealm(r.path));
  const libs = rows.filter((r) => !isRealm(r.path));

  const deck = (list: { path: string; deploy: GnoDeploy | null }[]): DeckRow[] =>
    list.map(({ path, deploy }) => ({
      key: path,
      search: `${path} ${deploy?.creator ?? ""}`,
      cells: [
        { v: shortPath(path), mono: true, href: packageHref(chainId, path) },
        deploy?.creator
          ? { v: truncateMiddle(deploy.creator, 8, 6), mono: true, address: deploy.creator }
          : { v: "-", dim: true },
        deploy
          ? deploy.height === 0
            ? { v: "Genesis", dim: true, align: "right" }
            : { v: deploy.height.toLocaleString(), mono: true, align: "right", href: `/${chainId}/blocks/${deploy.height}` }
          : { v: "-", dim: true, align: "right" },
        { v: deploy?.height === 0 ? "-" : day(deploy?.time ?? null), dim: true, align: "right" },
      ],
      detail: {
        title: shortPath(path),
        rows: [],
        action: { label: isRealm(path) ? "Realm" : "Package", href: packageHref(chainId, path) },
      },
    }));

  const columns = [
    { label: "Path" },
    { label: "Deployer", width: "22%", phoneHide: true },
    { label: "Block", align: "right" as const, width: "12%", phoneWidth: "26%" },
    { label: "Deployed", align: "right" as const, width: "14%", optional: true },
  ];
  const empty = paths ? "None" : "N/A";

  const sections = [
    {
      key: "realms",
      label: `Realms${paths ? ` (${realms.length})` : ""}`,
      content: (
        <RowDeck
          accent={accent}
          columns={columns}
          rows={deck(realms)}
          filter={{ placeholder: "Filter by path or deployer…" }}
          empty={empty}
        />
      ),
    },
    {
      key: "packages",
      label: `Packages${paths ? ` (${libs.length})` : ""}`,
      content: (
        <RowDeck
          accent={accent}
          columns={columns}
          rows={deck(libs)}
          filter={{ placeholder: "Filter by path or deployer…" }}
          empty={empty}
        />
      ),
    },
  ];

  const facts = paths
    ? [`${realms.length} realms`, `${libs.length} packages`, ...(deploys ? [`${new Set(rows.flatMap((r) => (r.deploy ? [r.deploy.creator] : []))).size} deployers`] : [])]
    : ["N/A"];

  return (
    <PageFrame title="Packages" sub={facts.join(" · ")} accent={accent}>
      <SectionTabs sections={sections} initial={tab} param="tab" />
    </PageFrame>
  );
}
