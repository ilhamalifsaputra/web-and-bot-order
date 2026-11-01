import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface QueryErrorNoticeProps {
  /** What failed to load, lower case, e.g. "orders". */
  what: string;
  /** True when the query still holds earlier data, i.e. this was a background refresh. */
  hasData: boolean;
  onRetry: () => void;
  /** Lets a page render the notice unconditionally; it draws nothing unless this is true (default). */
  isError?: boolean;
}

/**
 * A failed query, without taking the page away.
 *
 * With data on screen, a failed background refetch (a poll, a window refocus)
 * must not unmount the page: the admin may be halfway through a reply or a
 * refund reason. That case shows a small "Couldn't refresh" line with Retry.
 * With no data at all there is nothing to keep, so it says the load failed,
 * with Retry. A 401 is explained once by the session-ended banner in AppShell
 * (components/layout/SessionExpiredBanner.tsx), so this notice never repeats it.
 */
export function QueryErrorNotice({ what, hasData, onRetry, isError = true }: QueryErrorNoticeProps): React.JSX.Element | null {
  if (!isError) return null;
  const text = hasData
    ? `Couldn't refresh ${what}. Showing what was loaded earlier.`
    : `Failed to load ${what}.`;
  return (
    <div
      role={hasData ? "status" : "alert"}
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-rust/30 bg-rust/5 px-3 py-2 text-sm text-rust"
    >
      <p className="min-w-0 flex-1">{text}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

interface QueryFailureGateProps extends Omit<QueryErrorNoticeProps, "isError"> {
  isError: boolean;
  children: ReactNode;
  /** False when the page shows its own "Couldn't refresh" notice higher up
   *  (above other panels built from the same query), so it is not shown twice.
   *  The first-load notice still shows here. Default true. */
  showRefreshNotice?: boolean;
}

/**
 * Wraps the part of a list page that shows the query's rows (table, empty
 * state). The header, search, filters and tabs stay outside it, so a filter
 * that fails to load can still be changed.
 *
 * - no error: the rows, untouched;
 * - error with data (a failed refresh): the notice above the rows we still have;
 * - error and no data (first load): the notice INSTEAD of the rows, so the page
 *   never claims "No orders found" about a list it could not load.
 */
export function QueryFailureGate({ children, hasData, showRefreshNotice = true, ...notice }: QueryFailureGateProps): React.JSX.Element {
  return (
    <>
      <QueryErrorNotice {...notice} isError={notice.isError && (showRefreshNotice || !hasData)} hasData={hasData} />
      {hasData || !notice.isError ? children : null}
    </>
  );
}
