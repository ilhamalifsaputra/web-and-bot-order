import type { Ref } from "react";
import { Link } from "react-router-dom";
import { humanError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import Alert from "../ui/Alert";
import Button from "../ui/Button";

/**
 * The place-order failure, in one of three shapes:
 *
 *  - `sessionEnded`: a signed-in buyer whose session died. The server took its
 *    guest branch, so its own error (an email field this buyer never saw) is
 *    replaced by a way back in. `onLogin` runs before the link navigates so the
 *    page can keep what the buyer typed.
 *  - `unknown`: the attempt's outcome is unknown (no response, 5xx, still in
 *    progress), so the order may exist. Says so, points at where the order would
 *    show up, and offers a retry that repeats the identical request (and so the
 *    identical Idempotency-Key). A wallet payment never reads "nothing was
 *    charged": it may well have been.
 *  - otherwise the server's own refusal. Guest email errors stay beside the
 *    email field instead.
 */
export default function CheckoutErrorBanner({
  error,
  isGuest,
  anchorRef,
  sessionEnded,
  unknown,
}: {
  error: unknown;
  isGuest: boolean;
  anchorRef?: Ref<HTMLDivElement>;
  sessionEnded?: { onLogin: () => void } | null;
  unknown?: { wallet: boolean; onRetry: () => void; retryPending: boolean } | null;
}) {
  if (sessionEnded) {
    return (
      <div ref={anchorRef}>
        <Alert variant="banner" tone="warning" role="alert">
          {t("shop.session_ended_checkout")}{" "}
          <Link
            to="/login?next=/checkout"
            onClick={sessionEnded.onLogin}
            className="font-medium underline"
          >
            {t("shop.session_ended_login")}
          </Link>
        </Alert>
      </div>
    );
  }
  if (unknown) {
    return (
      <div ref={anchorRef}>
        <Alert variant="banner" tone="warning" role="alert" title={t("shop.checkout_unknown_title")}>
          {t(unknown.wallet ? "shop.checkout_unknown_body_wallet" : "shop.checkout_unknown_body")}
          <span className="mt-2 flex flex-wrap items-center gap-3">
            <Link to={isGuest ? "/track" : "/account/orders"} className="font-medium underline">
              {isGuest ? t("web.track_title") : t("shop.checkout_unknown_orders")}
            </Link>
            <Button type="button" variant="soft" size="sm" onClick={unknown.onRetry} disabled={unknown.retryPending}>
              {t("shop.checkout_unknown_retry")}
            </Button>
          </span>
        </Alert>
      </div>
    );
  }
  const key = error instanceof Error ? error.message : null;
  if (!key || (isGuest && key === "web.guest_email_invalid")) return null;
  return <div ref={anchorRef}><Alert variant="banner" tone="error">{humanError(error)}</Alert></div>;
}
