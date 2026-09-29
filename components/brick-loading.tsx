import { Skeleton } from "@/components/ui/skeleton";

/** Stands in for figure tiles at their exact size, so nothing moves when they land. */
export function BrickLoading({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="gata-surface gata-brick flex h-[5rem] flex-col justify-between px-3.5 py-2.5"
          aria-hidden="true"
        >
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-2 w-16" />
        </div>
      ))}
    </>
  );
}
