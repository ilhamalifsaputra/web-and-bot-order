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
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import type { EmptyStateAction } from "../components/shop/EmptyState";
import EmptyState from "../components/shop/EmptyState";
import Spinner from "../components/shop/Spinner";

/**
 * Where a failed lookup sends someone who has NO way to sign in.
 *
 * The obvious-looking "Help centre" (/account/support) is a trap here:
 * SupportPage redirects anonymous visitors to /login, and the entire audience
 * of this page is guests who never set a password — so that exit loops them
 * back to a door they have no key for. Both destinations below are reachable
 * with no session:
 *
 *  - `https://t.me/<bot_username>` — the shop's public Telegram handle, the
 *    same one HomePage's contact section and PayPage's gateway-down fallback
 *    link to. It rides on GET /api/v1/pages/context, which `optionalCustomer`
 *    serves to anonymous visitors (apiPages.ts) and which Layout has already
 *    fetched, so this costs no extra request and needs no new endpoint.
 *  - `/#kontak` — the home page's contact section, for a shop with no bot
 *    configured. A real navigation (`href`, not `to`) so the browser honours
 *    the anchor. The home page is public and its contact section always
 *    renders, so this is never a dead link.
 */
function useContactAction(): EmptyStateAction {
  const { data: ctx } = useShopContext();
  const botUsername = ctx?.bot_username ?? "";
  return botUsername
    ? { label: t("web.ticket_help_telegram"), href: `https://t.me/${botUsername}` }
    : { label: t("web.track_contact_shop"), href: "/#kontak" };
}

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
function FailureState({ failure, contact }: { failure: Failure; contact: EmptyStateAction }) {
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
        action={contact}
        secondaryAction={{ label: t("web.continue_shopping"), to: "/" }}
      />
    );
  }
  return (
    <EmptyState
      icon={PackageSearch}
      title={t("web.track_not_found_title")}
      description={t("web.track_not_found")}
      action={contact}
      // Secondary, not primary: signing in is the right move only for a
      // REGISTERED buyer who wandered onto this page, never for the guest it
      // was built for.
      secondaryAction={{ label: t("web.nav_login"), to: "/login" }}
    />
  );
}

export default function TrackOrderPage() {
  const [orderCode, setOrderCode] = useState("");
  const [email, setEmail] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const contact = useContactAction();

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
          explains what happened and offers somewhere else to go.
          role="alert" because submitting otherwise changes nothing a screen
          reader is told about — the outcome appears silently below the form
          the user is still focused in. */}
      {failure && !lookupMutation.isPending && (
        <div className="mt-6" role="alert">
          <FailureState failure={failure} contact={contact} />
        </div>
      )}
    </div>
  );
}
