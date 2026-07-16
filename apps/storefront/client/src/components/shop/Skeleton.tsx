/**
 * Shared skeleton-loading primitive (design-system.md, performance.md) — a
 * pulsing placeholder block. Pages that fetch their data client-side
 * (Home/Category/Search/Product/Account, …) currently render nothing at all
 * (`if (!data) return null;`) until the query resolves, which reads as a
 * blank/broken page on a slow connection. Compose `Skeleton` blocks into a
 * page-shaped placeholder instead. Hand-rolled, matching this app's existing
 * small-component convention (see `Flash.tsx`) — no new dependency.
 */
export interface SkeletonProps {
  className?: string;
}

export default function Skeleton({ className = "" }: SkeletonProps) {
  return <div aria-hidden="true" className={`animate-pulse rounded-xl bg-sand ${className}`} />;
}
