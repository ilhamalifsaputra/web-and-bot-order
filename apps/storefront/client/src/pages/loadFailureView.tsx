import type { ReactElement } from "react";
import { LoadFailedState } from "../components/shop/LoadFailed";
import { isUnauthorized } from "../lib/errors";
import ErrorPage from "./ErrorPage";

/**
 * What a detail page renders for a failed read, or `undefined` to render the
 * page itself (H4, UI-states audit). Shared by OrderDetailPage and
 * TicketDetailPage, which poll or refetch the record they show:
 *
 *  - 404: the not-found page, as before.
 *  - 401: nothing, while the page's own effect redirects to /login.
 *  - any other failure with nothing on screen yet: the error with a retry.
 *  - any other failure with data on screen: `undefined` — the page stays and
 *    shows its own "couldn't refresh" notice.
 */
export function loadFailureView(error: unknown, hasData: boolean, onRetry: () => void): ReactElement | null | undefined {
  if (!error) return undefined;
  if ((error as { status?: unknown }).status === 404) return <ErrorPage />;
  if (isUnauthorized(error)) return null;
  if (!hasData) return <LoadFailedState onRetry={onRetry} />;
  return undefined;
}
