/**
 * "I bought as a guest and I've lost my order" — the recovery path for a
 * shopper who has no password to sign in with (guest checkout, Task 6).
 *
 * POST /api/v1/track (apps/storefront/src/routes/apiTrack.ts) exchanges an
 * order code + the email used at checkout for a live session on that guest's
 * account, and answers with the order's own URL.
 *
 * Two things about the server contract shape this page:
 *
 *  1. EVERY failure is one identical 404 (`web.track_not_found`) — "no such
 *     order", "that order belongs to a registered account" and "wrong email"
 *     are deliberately indistinguishable, so the endpoint can't be used to
 *     probe for valid order codes. The UI must not leak more than the server
 *     does, so there is exactly one failure message here too; it never names
 *     which of the two fields was wrong.
 *  2. Success establishes a session mid-request. Like LoginPage, the redirect
 *     is a FULL page load rather than a react-router navigate(): the shell has
 *     to re-render for the whole app to see the new session (account menu,
 *     the CSRF meta tag). `publicPost` has already adopted the response's
 *     `csrf_token` by then, which covers anything the page does before the
 *     browser actually leaves.
 */
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Clock, PackageSearch, TriangleAlert } from "lucide-react";
import { publicPost } from "../api/client";
import type { TrackOrderResponse } from "../api/types";
import { t } from "../lib/i18n";
import EmptyState from "../components/shop/EmptyState";
import Spinner from "../components/shop/Spinner";

/** Which "it didn't work" screen a failed lookup earns. `not_found` covers
 * the server's single generic 404; `throttled` its 429; `error` anything else
 * (a 500, a dropped connection) — because rendering a raw server string at a
 * shopper is never the right answer. */
type Failure = "not_found" | "throttled" | "error";

function failureFor(errorKey: string): Failure {
  if (errorKey === "web.track_not_found") return "not_found";
  if (errorKey === "error.rate_limited") return "throttled";
  return "error";
}

/**
 * The failure screen. Each one names a next step — a lookup that just says
 * "no" and stops is a dead end, and this page is reached by people who
 * already can't find their order.
 */
function FailureState({ failure }: { failure: Failure }) {
  if (failure === "throttled") {
    return (
      <EmptyState
        icon={Clock}
        title={t("web.track_rate_limited_title")}
        description={t("web.track_rate_limited")}
        action={{ label: t("web.continue_shopping"), to: "/" }}
      />
    );
  }
  if (failure === "error") {
    return (
      <EmptyState
        icon={TriangleAlert}
        title={t("web.error_message")}
        action={{ label: t("web.nav_help"), to: "/account/support" }}
        secondaryAction={{ label: t("web.continue_shopping"), to: "/" }}
      />
    );
  }
  return (
    <EmptyState
      icon={PackageSearch}
      title={t("web.track_not_found_title")}
      description={t("web.track_not_found")}
      action={{ label: t("web.nav_help"), to: "/account/support" }}
      secondaryAction={{ label: t("web.nav_login"), to: "/login" }}
    />
  );
}

export default function TrackOrderPage() {
  const [orderCode, setOrderCode] = useState("");
  const [email, setEmail] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);

  const lookupMutation = useMutation({
    mutationFn: () =>
      publicPost<TrackOrderResponse>("/api/v1/track", {
        // The server upper/lower-cases and trims both of these itself; doing
        // it here too just means the request carries what the buyer will see
        // on the order page rather than whatever their keyboard produced.
        order_code: orderCode.trim().toUpperCase(),
        email: email.trim().toLowerCase(),
      }),
    onSuccess: (data) => window.location.assign(data.redirect),
    onError: (err) => setFailure(failureFor((err as Error).message)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFailure(null);
    lookupMutation.mutate();
  }

  const canSubmit = orderCode.trim() !== "" && email.trim() !== "" && !lookupMutation.isPending;

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="page-title mb-2">{t("web.track_title")}</h1>
      <p className="page-lead mb-6">{t("web.track_intro")}</p>

      <form onSubmit={onSubmit} className="card card-pad space-y-4">
        <div>
          <label className="field-label" htmlFor="track_order_code">
            {t("web.order_code")}
          </label>
          <input
            id="track_order_code"
            className="field uppercase"
            value={orderCode}
            onChange={(e) => setOrderCode(e.target.value)}
            autoComplete="off"
            maxLength={32}
            required
          />
        </div>
        <div>
          <label className="field-label" htmlFor="track_email">
            {t("web.guest_email_label")}
          </label>
          <input
            id="track_email"
            type="email"
            className="field"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
            required
          />
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={!canSubmit}>
          {lookupMutation.isPending && <Spinner />}
          {t("web.track_submit")}
        </button>
      </form>

      {/* The form above stays put, so retrying is one edit away; this only
          explains what happened and offers somewhere else to go. */}
      {failure && !lookupMutation.isPending && (
        <div className="mt-6">
          <FailureState failure={failure} />
        </div>
      )}
    </div>
  );
}
