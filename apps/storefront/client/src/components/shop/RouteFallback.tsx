import { t } from "../../lib/i18n";
import Skeleton from "./Skeleton";

/**
 * Suspense fallback for a lazily-loaded route chunk (App.tsx's per-route
 * `React.lazy`) — NOT a data-loading skeleton. Most pages already render
 * their own, richer skeleton while their own query is in flight (see
 * ReviewsPage.tsx et al.); this one only covers the moment between a route
 * match and its JS finishing download, which is instant on a warm cache and
 * brief even on a cold one. Kept deliberately small: a full-page spinner
 * here would make navigation feel slower, not faster, than the pages it
 * sits beside that never show one at all.
 *
 * Same `aria-busy`/`aria-label` treatment as every data-loading skeleton in
 * this app, so assistive tech announces this exactly like any other loading
 * state rather than a new, unannounced one.
 */
export default function RouteFallback() {
  return (
    <div aria-busy="true" aria-label={t("web.loading")}>
      <Skeleton className="mb-3 h-6 w-40" />
      <Skeleton className="h-24 w-full max-w-md" />
    </div>
  );
}
