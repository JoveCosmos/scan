import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown the moment a validator is clicked. The chain-wide loading screen never
 * appears for this move (the validators segment is shared by the list and the
 * page), so without this a click looked like it did nothing.
 *
 * Shaped like the page: profile column, a row of figures, tabs.
 */
export default function ValidatorLoading() {
  return (
    <div
      className="mx-auto flex h-full max-w-[90rem] flex-col px-4 py-3 sm:py-4"
      role="status"
      aria-label="Loading"
    >
      <div className="flex shrink-0 items-center gap-3 pb-3">
        <Skeleton className="h-7 w-7 rounded-full" />
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-5 w-16 rounded-md" />
        <Skeleton className="h-5 w-20 rounded-md" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:grid lg:grid-cols-[18.5rem_minmax(0,1fr)]">
        <div className="gata-surface order-last hidden flex-col gap-3 px-4 py-3.5 lg:order-none lg:flex">
          {[90, 70, 80, 60, 85, 75].map((w, i) => (
            <Skeleton key={i} className="h-3.5" style={{ width: `${w}%` }} />
          ))}
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
            {Array.from({ length: 8 }, (_, i) => (
              <div
                key={i}
                className="gata-surface gata-brick flex h-[5rem] flex-col justify-between px-3.5 py-2.5"
              >
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-2 w-16" />
              </div>
            ))}
          </div>
          <div className="gata-surface flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-4" style={{ width: `${[92, 80, 86, 74][i % 4]}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
