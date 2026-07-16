/**
 * Placeholder matching `ProductCard`'s card dimensions (h-44 image, name/
 * category/price lines) — used in a grid while a listing query is pending.
 * See `Skeleton.tsx`.
 */
import Skeleton from "./Skeleton";

export default function ProductCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-xs flex flex-col" aria-hidden="true">
      <Skeleton className="h-44 w-full rounded-none" />
      <div className="p-4 flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <div className="mt-2 flex items-center justify-between gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      </div>
    </div>
  );
}
