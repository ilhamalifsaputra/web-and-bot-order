import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useSessionExpired } from "../../api/sessionExpiry";

/** Pages that exist to log in or set up: a "session ended" banner there is noise. */
const AUTH_PATHS = ["/login", "/forgot", "/reset", "/bootstrap", "/setup"];

function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * One non-blocking notice when any API call found the session ended.
 *
 * It never redirects: "Log in" opens the login page in a NEW tab so whatever the
 * admin has typed here (a half-written ticket reply, a refund reason) stays
 * available, and "Reload" is there for after they have logged in.
 */
export function SessionExpiredBanner(): React.JSX.Element | null {
  const expired = useSessionExpired();
  const { pathname } = useLocation();
  if (!expired || isAuthPath(pathname)) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-rust/40 bg-rust/10 px-4 py-3 text-sm text-rust"
    >
      <p className="min-w-0 flex-1">
        Your session has ended. Log in again in a new tab; what you have typed here stays on this page.
      </p>
      <Button asChild size="sm">
        <a href="/login" target="_blank" rel="noopener noreferrer">Log in</a>
      </Button>
      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
