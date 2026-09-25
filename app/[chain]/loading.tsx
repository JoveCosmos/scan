import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown the instant a tab or a validator is clicked, while the server renders
 * the page. Without it the click appeared to do nothing until every read on
 * the next page had returned, which is what made switching tabs feel slow even
 * when the data was cached.
 *
 * Shaped like PageFrame — a heading, a row of facts, and a body that takes the
 * rest of the height — so the real page replaces it without the layout jumping.
 */
export default function ChainLoading() {
  return (
    <div
      className="mx-auto flex h-full max-w-[90rem] flex-col px-4 py-3 sm:py-4"
      role="status"
      aria-label="Loading"
    >
      <div className="flex shrink-0 items-start gap-3 pb-3">
        <Skeleton className="h-7 w-[3px] rounded-full" />
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-5 w-44" />
          <div className="flex flex-wrap gap-1.5">
            {[5.5, 7, 6, 4.5].map((w, i) => (
              <Skeleton key={i} className="h-5 rounded-md" style={{ width: `${w}rem` }} />
            ))}
          </div>
        </div>
      </div>
      <div className="gata-surface min-h-0 flex-1 overflow-hidden p-3">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton
              key={i}
              className="h-4"
              style={{ width: `${[92, 80, 86, 74, 90, 68][i % 6]}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
