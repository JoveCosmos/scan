import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { getChain } from "@/lib/chains";

/**
 * A chain's landing page is its validator set.
 *
 * Params is the chain's identity card, so the chain root opens there. Every
 * other tab keeps its own route.
 */
export default async function ChainRootPage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain: chainId } = await params;
  // Validate here so an unknown chain still 404s rather than redirecting into
  // another 404 one hop later.
  if (!getChain(chainId)) notFound();

  redirect(`/${chainId}/params`);
}
