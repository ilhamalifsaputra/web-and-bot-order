import type { Ref } from "react";
import { Link } from "react-router-dom";
import { humanError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import Alert from "../ui/Alert";
import Button from "../ui/Button";

/**
 * The place-order failure, in one of these shapes:
 *
 *  - `sessionEnded`: a signed-in buyer whose session died. The server took its
 *    guest branch, so its own error (an email field this buyer never saw) is
 *    replaced by a way back in. The login opens in a NEW tab, so this tab — and
 *    everything typed into it, held in memory only — stays exactly as it is;
 *    the page's next read picks up the new session and its CSRF token.
 *  - `unknown`: the attempt's outcome is unknown (no response, 5xx, still in
 *    progress), so the order may exist. Says so, points at where the order
 *    would show up, and offers a retry that repeats the identical request (and
 *    so the identical Idempotency-Key), plus Start over. A wallet payment never
 *    reads "nothing was charged": it may well have been. With `probablyPlaced`
 *    (the cart came back empty after such an attempt) there is nothing left to
 *    retry: it says the order was most likely placed.
 *  - otherwise the server's own refusal. Guest email errors stay beside the
 *    email field instead.
 */
export interface UnknownOutcome {
  wallet: boolean;
  probablyPlaced: boolean;
  onRetry: () => void;
  retryPending: boolean;
  onStartOver: () => void;
}

function SessionEndedNotice() {
  return (
    <Alert variant="banner" tone="warning" role="alert">
      {t("shop.session_ended_checkout")}{" "}
      <a href="/login?next=/checkout" target="_blank" rel="noopener noreferrer" className="font-medium underline">
        {t("shop.session_ended_login")}
      </a>
    </Alert>
  );
}

function UnknownOutcomeNotice({ unknown, isGuest }: { unknown: UnknownOutcome; isGuest: boolean }) {
  const body = unknown.probablyPlaced
    ? "shop.checkout_probably_placed"
    : unknown.wallet ? "shop.checkout_unknown_body_wallet" : "shop.checkout_unknown_body";
  return (
    <Alert variant="banner" tone="warning" role="alert" title={t("shop.checkout_unknown_title")}>
      {t(body)}
      <span className="mt-2 flex flex-wrap items-center gap-3">
        <Link to={isGuest ? "/track" : "/account/orders"} className="font-medium underline">
          {isGuest ? t("web.track_title") : t("shop.checkout_unknown_orders")}
        </Link>
        {!unknown.probablyPlaced && (
          <Button type="button" variant="soft" size="sm" onClick={unknown.onRetry} disabled={unknown.retryPending}>
            {t("shop.checkout_unknown_retry")}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={unknown.onStartOver}>
          {t("shop.checkout_start_over")}
        </Button>
      </span>
    </Alert>
  );
}

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
  sessionEnded?: boolean;
  unknown?: UnknownOutcome | null;
}) {
  if (sessionEnded) return <div ref={anchorRef}><SessionEndedNotice /></div>;
  if (unknown) return <div ref={anchorRef}><UnknownOutcomeNotice unknown={unknown} isGuest={isGuest} /></div>;
  const key = error instanceof Error ? error.message : null;
  if (!key || (isGuest && key === "web.guest_email_invalid")) return null;
  return <div ref={anchorRef}><Alert variant="banner" tone="error">{humanError(error)}</Alert></div>;
}
