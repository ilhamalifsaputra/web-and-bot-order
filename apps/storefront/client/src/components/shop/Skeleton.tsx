/**
 * Moved to `components/ui/Skeleton.tsx` in Fase 6 (business-agnostic
 * primitive). This re-export keeps the ~15 existing
 * `components/shop/Skeleton` importers working; new code should import from
 * `components/ui/Skeleton`.
 */
export { default } from "../ui/Skeleton";
export type { SkeletonProps } from "../ui/Skeleton";
