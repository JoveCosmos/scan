import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getChain } from "@/lib/chains";
import { GovdaoMembers } from "../proposals/govdao";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  return { title: chain ? `${chain.prettyName} GovDAO members` : "Members" };
}

/** gno.land's GovDAO members, by tier. */
export default async function MembersPage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain: chainId } = await params;
  const chain = getChain(chainId);
  if (!chain || chain.kind !== "gno") notFound();
  return <GovdaoMembers chain={chain} />;
}
