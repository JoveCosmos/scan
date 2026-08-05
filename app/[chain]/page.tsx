import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { getChain } from "@/lib/chains";

/**
 * A chain's landing page is its validator set.
 *
 * Validators are what this explorer is mostly for, so the chain root goes
 * straight there rather than to a summary page. Chain parameters keep their own
 * tab at /params.
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

  redirect(`/${chainId}/validators`);
}
