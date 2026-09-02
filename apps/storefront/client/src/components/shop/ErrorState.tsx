/**
 * ErrorState — §16 "Error": a data-bound view whose own fetch failed.
 *
 * Deliberately NOT handed the error object. A raw `Error.message`, a stack, or
 * a bare HTTP status is noise-or-worse to a shopper ("AxiosError: Request
 * failed with status code 500") and risks leaking internals — the caller
 * passes friendly, already-localised copy instead. The one affordance that
 * matters is getting back to a working state:
 *
 *   - `onRetry`  → a "Try again" button that re-runs the caller's query;
 *   - no `onRetry` → a "Reload page" link (full document reload) as a fallback.
 */
import { ServerCrash } from "lucide-react";
import { t } from "../../lib/i18n";
import StatusScreen from "./StatusScreen";

export interface ErrorStateProps {
  /** Friendly, already-localised. NEVER pass an `Error.message` here. */
  title?: string;
  /** Friendly, already-localised. NEVER pass a stack / status code here. */
  description?: string;
  /** Re-run the failed request. Omit → the action becomes a full page reload. */
  onRetry?: () => void;
  /** Render without the card chrome (caller owns the surface). */
  bare?: boolean;
}

export default function ErrorState({ title, description, onRetry, bare }: ErrorStateProps) {
  return (
    <StatusScreen
      bare={bare}
      tone="danger"
      icon={ServerCrash}
      title={title ?? t("web.state_error_title")}
      description={description ?? t("web.state_error_body")}
      action={
        onRetry
          ? { label: t("web.state_retry"), onClick: onRetry }
          : { label: t("web.state_reload"), href: typeof window !== "undefined" ? window.location.href : "/" }
      }
    />
  );
}
