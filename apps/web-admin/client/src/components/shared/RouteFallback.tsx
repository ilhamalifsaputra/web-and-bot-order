import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "./LoadingRegion";

/** The admin's one loader for a lazily-loaded route chunk (App.tsx's
 * top-level Suspense and PageTransition's in-shell Suspense both use it).
 * Shaped like a PageHeader over a card so the real page swaps in without a
 * jump; no full-page spinner. */
export function RouteFallback(): React.JSX.Element {
  return (
    <LoadingRegion label="Loading page" className="w-full">
      <div className="mb-6 flex flex-col gap-2 sm:mb-8">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    </LoadingRegion>
  );
}

/** Generic detail-page skeleton (header + main column + side column) for
 * pages whose record loads as a whole. */
export function DetailPageSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <LoadingRegion label={label}>
      <div className="mb-6 flex flex-col gap-2 sm:mb-8">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      </div>
    </LoadingRegion>
  );
}
