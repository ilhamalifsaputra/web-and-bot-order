/**
 * Query failure states shared by the data-bound pages (H3/H4, UI-states audit).
 *
 * `LoadFailedState`: the page's first load failed and there is nothing to show.
 * Before this, pages that tested only `!data` rendered their skeleton forever,
 * which reads exactly like loading. It announces itself (`role="alert"`) and
 * offers a retry that re-runs the caller's query.
 *
 * `RefreshFailedNotice`: a background refetch or poll failed while the page
 * already shows data. The page stays mounted (an order's credentials, an
 * unsent edit) and this small notice says the view may be out of date, as a
 * polite `status` rather than an alert.
 *
 * A 401 is not a failure to show (`isUnauthorized`, lib/errors.ts) — those
 * pages are already redirecting to /login.
 */
import { RefreshCw } from "lucide-react";
import { t } from "../../lib/i18n";
import Button from "../ui/Button";
import ErrorState from "./ErrorState";

export function LoadFailedState({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert">
      <ErrorState onRetry={onRetry} />
    </div>
  );
}

export function RefreshFailedNotice({ onRetry, pending }: { onRetry: () => void; pending?: boolean }) {
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amberx/30 bg-amberx-tint px-4 py-2 text-sm text-ink-soft"
    >
      <span>{t("shop.refresh_failed")}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry} pending={pending}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" /> {t("web.state_retry")}
      </Button>
    </div>
  );
}
