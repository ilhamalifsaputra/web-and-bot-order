/**
 * Skeleton — a pulsing placeholder block. Pages that fetch data client-side
 * compose these into a page-shaped placeholder instead of rendering nothing
 * until the query resolves. Hand-rolled, no dependency.
 *
 * Promoted from `components/shop/` to `components/ui/` in Fase 6 as a
 * business-agnostic primitive; `components/shop/Skeleton.tsx` re-exports this.
 */
export interface SkeletonProps {
  className?: string;
}

export default function Skeleton({ className = "" }: SkeletonProps) {
  return <div aria-hidden="true" className={`animate-pulse rounded-xl bg-sand ${className}`} />;
}
