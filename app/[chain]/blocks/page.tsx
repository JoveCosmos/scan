import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getChain, accentFor } from "@/lib/chains";
import { getAdapter } from "@/lib/adapter";
import { nameProposers, RECENT_BLOCK_COUNT } from "@/lib/blocks";
import { PageFrame } from "@/components/page-frame";
import { BlocksTable } from "@/components/blocks-table";

export const dynamic = "force-dynamic";

// Sits in the list card's footer bar, beside where the list stands.
const pager =
  "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-[var(--gata-card-hi)] hover:text-foreground";

/**
 * The newest blocks, streaming; `?before=<height>` shows the fixed window of
 * blocks below that height instead, so history can be walked back page by
 * page without the feed moving under the reader.
 */
export default async function BlocksPage({
  params,
  searchParams,
}: {
  params: Promise<{ chain: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { chain: chainId } = await params;
  const { before: beforeParam } = await searchParams;
  const chain = getChain(chainId);
  if (!chain) notFound();

  const adapter = getAdapter(chain);
  const before =
    beforeParam && /^\d+$/.test(beforeParam) && Number(beforeParam) > 1
      ? Number(beforeParam)
      : null;

  const [blocks, validators] = await Promise.all([
    before
      ? adapter.getBlocksBefore(before, RECENT_BLOCK_COUNT)
      : adapter.getRecentBlocks(),
    adapter.getValidators().catch(() => []),
  ]);
  const named = nameProposers(blocks, validators, chain.bech32Prefix);

  const lowest =
    named.length > 0 ? Number(named[named.length - 1].height) : null;
  const newer = before ? before + RECENT_BLOCK_COUNT : null;

  return (
    <PageFrame
      title="Blocks"
      sub={
        before
          ? `Below #${before.toLocaleString()} · ${chain.prettyName}`
          : `Streaming from ${chain.prettyName}`
      }
      accent={accentFor(chain)}
    >
      <BlocksTable
        key={before ?? "live"}
        chainId={chain.chainId}
        accent={accentFor(chain)}
        initialBlocks={named}
        live={!before}
        footer={
          <>
            {before ? (
              <Link
                href={`/${chainId}/blocks${newer ? `?before=${newer}` : ""}`}
                aria-label="Newer blocks"
                className={pager}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Newer
              </Link>
            ) : null}
            {before ? (
              <Link href={`/${chainId}/blocks`} className={pager}>
                Latest
              </Link>
            ) : null}
            {lowest && lowest > 1 ? (
              <Link
                href={`/${chainId}/blocks?before=${lowest}`}
                aria-label="Older blocks"
                className={pager}
              >
                Older <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            ) : null}
          </>
        }
      />
    </PageFrame>
  );
}
