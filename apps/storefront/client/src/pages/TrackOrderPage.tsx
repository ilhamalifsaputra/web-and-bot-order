/** Pemulihan guest: kode dan token order, pesan gagal generik, tanpa auto-login. */
import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Clock, PackageSearch, TriangleAlert } from "lucide-react";
import { publicPost } from "../api/client";
import type { TrackOrderResponse } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import type { EmptyStateAction } from "../components/shop/EmptyState";
import EmptyState from "../components/shop/EmptyState";
import Spinner from "../components/shop/Spinner";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import FormField from "../components/ui/FormField";
import Input from "../components/ui/Input";

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
 *  - `/#contact` — the home page's contact section, for a shop with no bot
 *    configured. A real navigation (`href`, not `to`) so the browser honours
 *    the anchor. The home page is public and its contact section always
 *    renders, so this is never a dead link.
 */
function useContactAction(): EmptyStateAction {
  const { data: ctx } = useShopContext();
  const botUsername = ctx?.bot_username ?? "";
  return botUsername
    ? { label: t("web.ticket_help_telegram"), href: `https://t.me/${botUsername}` }
    : { label: t("web.track_contact_shop"), href: "/#contact" };
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
function FailureState({
  failure,
  contact,
  isSignedIn,
}: {
  failure: Failure;
  contact: EmptyStateAction;
  isSignedIn: boolean;
}) {
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
      // Secondary, not primary: this page is reachable from the nav now, so
      // both audiences show up here as expected traffic, not an accident —
      // a signed-in customer who wandered in (their own orders page is the
      // right next step) and a REGISTERED-but-signed-out buyer who wandered
      // in (signing in is). A signed-in visitor has no use for a login link
      // to a session they already hold, so this is one or the other, never
      // both.
      secondaryAction={
        isSignedIn
          ? { label: t("web.nav_orders"), to: "/account/orders" }
          : { label: t("web.nav_login"), to: "/login" }
      }
    />
  );
}

export default function TrackOrderPage() {
  const [recovery] = useState(() => new URLSearchParams(window.location.hash.slice(1)));
  const [orderCode, setOrderCode] = useState(recovery.get("order_code") ?? "");
  const [accessToken, setAccessToken] = useState(recovery.get("access_token") ?? "");
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  const [failure, setFailure] = useState<Failure | null>(null);
  const contact = useContactAction();
  // Shares the query cache useContactAction's useShopContext() call already
  // populated, so this costs no extra request. A signed-in customer who
  // clicks "Track order" out of curiosity (the nav entry is new — this page
  // used to be unreachable while signed in) shouldn't be told to sign in
  // when a lookup fails; they already are.
  const { data: shopContext } = useShopContext();
  const isSignedIn = Boolean(shopContext?.customer);

  const lookupMutation = useMutation({
    mutationFn: () =>
      publicPost<TrackOrderResponse>("/api/v1/track", {
        // The server upper/lower-cases and trims this itself; doing it here
        // too just means the request carries what the buyer will see on the
        // order page rather than whatever their keyboard produced.
        order_code: orderCode.trim().toUpperCase(),
        access_token: accessToken.trim(),
      }),
    onSuccess: (data) => window.location.assign(data.redirect),
    onError: (err) => setFailure(failureFor((err as Error).message)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFailure(null);
    lookupMutation.mutate();
  }

  const canSubmit = orderCode.trim() !== "" && !lookupMutation.isPending;

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="page-title mb-2">{t("web.track_title")}</h1>
      <p className="page-lead mb-6">{t("web.track_intro")}</p>

      <Card>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField label={t("web.order_code")} htmlFor="track_order_code">
            <Input
              id="track_order_code"
              className="uppercase"
              value={orderCode}
              onChange={(e) => setOrderCode(e.target.value)}
              autoComplete="off"
              maxLength={32}
              required
            />
          </FormField>
          <FormField label={t("web.track_access_token")} htmlFor="track_access_token">
            <Input id="track_access_token" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} autoComplete="off" maxLength={1024} required />
          </FormField>
          <Button type="submit" variant="primary" fullWidth disabled={!canSubmit}>
            {lookupMutation.isPending && <Spinner />}
            {t("web.track_submit")}
          </Button>
        </form>
      </Card>

      {/* The form above stays put, so retrying is one edit away; this only
          explains what happened and offers somewhere else to go.
          role="alert" because submitting otherwise changes nothing a screen
          reader is told about — the outcome appears silently below the form
          the user is still focused in. */}
      {failure && !lookupMutation.isPending && (
        <div className="mt-6" role="alert">
          <FailureState failure={failure} contact={contact} isSignedIn={isSignedIn} />
        </div>
      )}
    </div>
  );
}
