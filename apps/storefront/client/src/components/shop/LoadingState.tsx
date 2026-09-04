/**
 * LoadingState — §16 "Loading": the fallback skeleton for a full-page client
 * fetch on a page that has no bespoke skeleton of its own.
 *
 * §16 forbids a bare spinner for a full-page load — it must be a skeleton that
 * roughly matches the loaded layout so the swap causes no layout shift. Pages
 * that already ship a good page-shaped skeleton (ReviewsPage et al.) keep it;
 * this is the default for the ones that don't, not a mandate to replace them.
 *
 * Same `aria-busy` + `aria-label` treatment as `RouteFallback` and every other
 * loading skeleton in the app, so assistive tech announces it identically
 * rather than as a new, unlabelled state. `variant` picks the silhouette.
 */
import { t } from "../../lib/i18n";
import Skeleton from "../ui/Skeleton";

export type LoadingStateVariant = "page" | "list" | "detail" | "form";

export interface LoadingStateProps {
  /** Silhouette to match the page being loaded. Default: `page`. */
  variant?: LoadingStateVariant;
  /** Override the default localised "Loading…" announcement. */
  label?: string;
}

export default function LoadingState({ variant = "page", label }: LoadingStateProps) {
  return (
    <div aria-busy="true" aria-label={label ?? t("web.loading")} className="space-y-4">
      {variant === "page" && (
        <>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="mt-2 h-64 w-full" />
        </>
      )}

      {variant === "list" && (
        <>
          <Skeleton className="h-8 w-1/3" />
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </>
      )}

      {variant === "detail" && (
        <div className="grid gap-6 sm:grid-cols-2">
          <Skeleton className="aspect-square w-full" />
          <div className="space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="mt-2 h-11 w-40" />
          </div>
        </div>
      )}

      {variant === "form" && (
        <div className="mx-auto max-w-md space-y-5">
          <Skeleton className="h-8 w-1/2" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-11 w-full" />
            </div>
          ))}
          <Skeleton className="h-11 w-full" />
        </div>
      )}
    </div>
  );
}
