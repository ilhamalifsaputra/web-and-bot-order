import { Button } from "@/components/ui/button";
import { isSessionExpiredError } from "../../api/sessionExpiry";

interface QueryErrorNoticeProps {
  /** What failed to load, lower case, e.g. "orders". */
  what: string;
  /** True when the query still holds earlier data, i.e. this was a background refresh. */
  hasData: boolean;
  onRetry: () => void;
  error?: unknown;
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
 * with Retry. The session-ended banner in AppShell explains a 401, so this
 * notice does not repeat it.
 */
export function QueryErrorNotice({ what, hasData, onRetry, error, isError = true }: QueryErrorNoticeProps): React.JSX.Element | null {
  const sessionEnded = isSessionExpiredError(error);
  const text = hasData
    ? `Couldn't refresh ${what}. Showing what was loaded earlier.`
    : `Failed to load ${what}.`;
  if (!isError) return null;
  return (
    <div
      role={hasData ? "status" : "alert"}
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-rust/30 bg-rust/5 px-3 py-2 text-sm text-rust"
    >
      <p className="min-w-0 flex-1">
        {text}
        {sessionEnded ? " Your session has ended." : ""}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
