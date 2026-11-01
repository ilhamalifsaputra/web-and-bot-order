import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** The accessible wrapper every loading skeleton sits in: a busy `status`
 * live region whose only readable content is visually-hidden text saying
 * what is loading ("Loading orders"), so a screen reader announces it once.
 * No `aria-label` on top: it would repeat the same words. The skeleton
 * blocks inside stay `aria-hidden`. */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** A few text-line skeletons for a card body whose rows load with it. */
export function LinesSkeleton({
  label,
  lines = 3,
  className,
}: {
  label: string;
  lines?: number;
  className?: string;
}): React.JSX.Element {
  const widths = ["w-full", "w-5/6", "w-2/3", "w-3/4"];
  return (
    <LoadingRegion label={label} className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-4", widths[i % widths.length])} />
      ))}
    </LoadingRegion>
  );
}

/** A KPI card body while its number loads: a headline value bar over a
 * caption line, so the card keeps its height and never shows a zero. */
export function KpiSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <LoadingRegion label={label} className="flex flex-col gap-2">
      <Skeleton className="h-9 w-28" />
      <Skeleton className="h-3 w-full" />
    </LoadingRegion>
  );
}
