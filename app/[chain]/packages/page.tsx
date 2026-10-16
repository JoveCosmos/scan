import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain, accentFor } from "@/lib/chains";
import { PageFrame } from "@/components/page-frame";
import { SectionTabs } from "@/components/section-tabs";
import { RowDeck } from "@/components/row-deck";
import { LazyDeck } from "@/components/lazy-deck";
import { loadPackageList, PACKAGE_COLUMNS, packageRows } from "./rows";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} packages` : "Packages" };
}

/**
 * gno.land's code: realms (stateful, callable) and packages (libraries),
 * newest first, with who deployed each. The tab open on arrival comes with its
 * rows; the other loads them when opened.
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

  const { paths, realms, libs, deployers, names } = await loadPackageList(chain);
  const open = tab === "packages" ? "packages" : "realms";
  const empty = paths ? "None" : "N/A";
  const filter = { placeholder: "Filter by path or deployer…" };

  const deck = (kind: "realms" | "packages") =>
    kind === open || !paths ? (
      <RowDeck
        accent={accent}
        columns={PACKAGE_COLUMNS}
        rows={packageRows(chainId, kind === "realms" ? realms : libs, names)}
        filter={filter}
        empty={empty}
      />
    ) : (
      <LazyDeck
        endpoint={`/api/chains/${chainId}/packages/list?kind=${kind}`}
        accent={accent}
        columns={PACKAGE_COLUMNS}
        filter={filter}
        empty={empty}
      />
    );

  const sections = [
    { key: "realms", label: `Realms${paths ? ` (${realms.length})` : ""}`, content: deck("realms") },
    { key: "packages", label: `Packages${paths ? ` (${libs.length})` : ""}`, content: deck("packages") },
  ];

  const facts = paths
    ? [`${realms.length} realms`, `${libs.length} packages`, ...(deployers !== null ? [`${deployers} deployers`] : [])]
    : ["N/A"];

  return (
    <PageFrame title="Packages" sub={facts.join(" · ")} accent={accent}>
      <SectionTabs sections={sections} initial={tab} param="tab" />
    </PageFrame>
  );
}
