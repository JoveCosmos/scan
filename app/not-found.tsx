import Link from "next/link";
import { SearchBar } from "@/components/search-bar";

/**
 * Anything that does not exist: an unknown chain or a malformed id (a real
 * 404, from middleware.ts), or a well-formed block, transaction or address the
 * chain does not have (rendered after the stream began, so marked noindex).
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-display text-[22px] font-semibold tracking-[-0.02em]">Not found</p>
      <div className="w-full">
        <SearchBar size="lg" />
      </div>
      <Link href="/" className="text-[13px] text-primary underline decoration-transparent underline-offset-2 hover:decoration-current">
        Home
      </Link>
    </div>
  );
}
