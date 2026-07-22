/**
 * TSX port of apps/storefront/views/settings.njk. Two independent flash
 * sources feed the ONE `error` spot the template renders: the query params
 * the old server route redirected back with (?saved=1, ?linked=1,
 * ?err=tg_taken|tg_invalid — the Telegram-link redirect flow, GET
 * /account/settings/link-telegram, stays server-side per the brief) and a
 * failed credentials POST, which — like checkout's voucher preview — never
 * navigates, so the query params can't be showing at the same time as a POST
 * error. Username/email are controlled (seeded once from the GET, the same
 * "page" pattern CheckoutPage uses so a later background refetch can't
 * clobber what the user is mid-typing); the password fields are read via
 * FormData at submit like every other auth form. The Telegram widget embed
 * mirrors LoginPage's script-injection effect, but `data-auth-url` is the
 * fixed server route (not fetched) and the gate is `!tg_linked && bot_username`
 * per settings.njk. The form markup has since been reworked for the phone —
 * consistent label/field spacing, mobile keyboard hints, and the credentials
 * error moved next to the button that produced it — but every endpoint,
 * payload and validation rule is unchanged from the port.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle, Send } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { SettingsData } from "../api/types";
import { t } from "../lib/i18n";
import { useTelegramWidget } from "../lib/useTelegramWidget";
import Flash from "../components/shop/Flash";
import PasswordInput from "../components/shop/PasswordInput";
import Spinner from "../components/shop/Spinner";

interface CredentialsVars {
  username: string;
  email: string;
  current_password: string;
  new_password: string;
}

export default function SettingsPage() {
  const [params] = useSearchParams();
  const { data, error } = useQuery({
    queryKey: ["account-settings"],
    queryFn: () => apiGet<SettingsData>("/api/v1/account/settings"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account/settings"));
    }
  }, [error]);

  // First load only: seed the editable username/email fields — a later
  // background refetch of this query must not clobber what's mid-typing.
  const [page, setPage] = useState<SettingsData | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    if (data && !page) {
      setPage(data);
      setUsername(data.values.username);
      setEmail(data.values.email);
    }
  }, [data, page]);

  const credentialsMutation = useMutation({
    mutationFn: (vars: CredentialsVars) =>
      apiPost<{ ok: boolean; password_changed: boolean }>("/api/v1/account/settings/credentials", vars),
    // Full reload (not navigate()) — the cookie/CSRF may have rotated on a
    // password change, mirroring the old route's 303.
    onSuccess: () => window.location.assign("/account/settings?saved=1"),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    credentialsMutation.mutate({
      username,
      email,
      current_password: String(formData.get("current_password") ?? ""),
      new_password: String(formData.get("new_password") ?? ""),
    });
  }

  // Telegram widget script injection — same pattern as LoginPage, but the
  // auth-url is the fixed server route rather than a fetched value. The
  // widget only mounts once `page` is seeded and the account isn't already
  // linked, per settings.njk's `!tg_linked && bot_username` gate.
  const widgetContainerRef = useRef<HTMLDivElement>(null);
  const widgetFailed = useTelegramWidget(widgetContainerRef, {
    botUsername: page && !page.tg_linked ? page.bot_username : null,
    authUrl: "/account/settings/link-telegram",
  });

  if (!page) return null;

  const queryErrorText =
    params.get("err") === "tg_taken"
      ? t("web.settings_tg_taken")
      : params.get("err") === "tg_invalid"
        ? t("web.error_message")
        : null;
  const mutationErrorKey = credentialsMutation.error ? (credentialsMutation.error as Error).message : null;
  // A failed credentials POST is about the form, so it renders inside the
  // form; only the redirect-flow (?err=…) messages, which belong to the
  // Telegram link round-trip, stay at page level. The two can never be
  // showing at once — a failed POST never navigates.
  const mutationErrorText = mutationErrorKey ? t(mutationErrorKey) : null;
  const saved = Boolean(params.get("saved"));
  const linked = Boolean(params.get("linked"));

  return (
    <>
      <h1 className="page-title mb-6">{t("web.settings_title")}</h1>

      {queryErrorText && (
        <div className="mb-4 max-w-md">
          <Flash text={queryErrorText} kind="error" />
        </div>
      )}
      {saved && (
        <div className="mb-4 max-w-md">
          <Flash text={t("web.settings_saved")} kind="info" />
        </div>
      )}
      {linked && (
        <div className="mb-4 max-w-md">
          <Flash text={t("web.settings_tg_done")} kind="info" />
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <div className="card card-pad">
          <h2 className="font-display text-lg font-semibold mb-4">{t("web.settings_login_section")}</h2>
          {/* `space-y-5` rather than `space-y-4`: with a help line hanging off
              the username field, tighter gaps made the help text look like it
              belonged to the field below it. */}
          <form onSubmit={onSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="username">
                {t("web.register_username")}
              </label>
              <input
                className="field"
                type="text"
                id="username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                // The pattern below only accepts lowercase, so a phone keyboard
                // must not auto-capitalise or autocorrect what is typed here —
                // otherwise the field silently fails validation on the first
                // character. Unchanged rules, just a keyboard that respects them.
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                minLength={3}
                maxLength={32}
                // STO-014: must match LOGIN_USERNAME_RE (packages/db/src/crud/webauth.ts).
                pattern="[a-z0-9_]+"
                aria-describedby="username_help"
              />
              <p id="username_help" className="text-xs text-ink-faint mt-1.5">
                {t("web.register_username_help")}
              </p>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="email">
                {t("web.register_email")}
              </label>
              <input
                className="field"
                type="email"
                id="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                // `type="email"` alone is enough on iOS but not everywhere;
                // inputMode makes the "@" and "." keyboard the explicit ask.
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            {page.has_password && (
              <div>
                <label className="block text-sm font-semibold mb-1.5" htmlFor="current_password">
                  {t("web.settings_current_password")}
                </label>
                <PasswordInput
                  className="field"
                  id="current_password"
                  name="current_password"
                  autoComplete="current-password"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="new_password">
                {t("web.settings_new_password")}
              </label>
              <PasswordInput
                className="field"
                id="new_password"
                name="new_password"
                autoComplete="new-password"
                minLength={8}
              />
            </div>
            {/* Next to the button that produced it: on a phone a failure
                announced at the top of the page is off-screen by the time the
                thumb reaches Save. `role="alert"` so it is spoken when it
                appears rather than only on the next focus move. */}
            {mutationErrorText && (
              <div role="alert">
                <Flash text={mutationErrorText} kind="error" />
              </div>
            )}
            <button
              type="submit"
              className="btn btn-primary w-full sm:w-auto"
              disabled={credentialsMutation.isPending}
            >
              {credentialsMutation.isPending && <Spinner />}
              {t("web.settings_save")}
            </button>
          </form>
        </div>

        <div className="card card-pad">
          <h2 className="font-display text-lg font-semibold mb-4">{t("web.settings_tg_section")}</h2>
          {page.tg_linked ? (
            <div className="flex items-center gap-3 rounded-xl border border-grass/30 bg-grass-tint px-4 py-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-card text-grass">
                <CheckCircle className="w-5 h-5" />
              </span>
              <p className="text-sm text-grass-dark">{t("web.settings_tg_linked", { name: page.tg_name })}</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-ink-soft mb-4">{t("web.settings_tg_hint")}</p>
              {page.bot_username ? (
                <div className="rounded-xl border border-line bg-paper px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-3 flex items-center gap-1.5">
                    <Send className="w-3.5 h-3.5" /> {t("web.settings_tg_connect_label")}
                  </p>
                  {/* STO-013: Telegram renders its own raw, unstyled error text
                      (e.g. "Bot domain invalid") into this container when the
                      origin isn't authorized — hide it and show our own styled
                      fallback instead of leaking that text into the page. */}
                  <div ref={widgetContainerRef} className={widgetFailed ? "hidden" : ""} />
                  {widgetFailed && (
                    <p className="text-sm text-ink-soft">
                      {t("web.tg_widget_unavailable_prefix")}{" "}
                      <Link to="/account/support" className="text-pine underline hover:text-pine-dark">
                        {t("web.tg_widget_unavailable_link")}
                      </Link>
                      {t("web.tg_widget_unavailable_suffix")}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-ink-faint">{t("web.settings_tg_unconfigured")}</p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
