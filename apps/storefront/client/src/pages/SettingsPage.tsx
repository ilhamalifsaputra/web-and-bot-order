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
 * per settings.njk. Markup/classes copied verbatim — no v3→v4 renames apply
 * to this page (settings.njk's only bare-`rounded` here is `rounded-full`/
 * `rounded-xl`, both unaffected).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle, Send } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { SettingsData } from "../api/types";
import { t } from "../lib/i18n";
import Flash from "../components/shop/Flash";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

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
  // auth-url is the fixed server route rather than a fetched value. Keyed on
  // `page` (not `data`): the container div only renders once `page` is
  // seeded, so an effect keyed on `data` would fire one render too early and
  // bail on the still-null ref.
  const widgetContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = widgetContainerRef.current;
    if (!container || !page || page.tg_linked || !page.bot_username) return;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", page.bot_username);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-radius", "12");
    script.setAttribute("data-auth-url", "/account/settings/link-telegram");
    script.setAttribute("data-request-access", "write");
    container.appendChild(script);
    return () => {
      container.removeChild(script);
    };
  }, [page]);

  if (!page) return null;

  const queryErrorText =
    params.get("err") === "tg_taken"
      ? t("web.settings_tg_taken")
      : params.get("err") === "tg_invalid"
        ? t("web.error_message")
        : null;
  const mutationErrorKey = credentialsMutation.error ? (credentialsMutation.error as Error).message : null;
  const errorText = mutationErrorKey ? t(mutationErrorKey) : queryErrorText;
  const saved = Boolean(params.get("saved"));
  const linked = Boolean(params.get("linked"));

  return (
    <>
      <h1 className="page-title mb-6">{t("web.settings_title")}</h1>

      {errorText && (
        <div className="mb-4 max-w-md">
          <Flash text={errorText} kind="error" />
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
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-semibold" htmlFor="username">
                {t("web.register_username")}
              </label>
              <input
                className="field mt-1"
                type="text"
                id="username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                minLength={3}
                maxLength={32}
                pattern="[a-zA-Z0-9_]+"
              />
              <p className="text-xs text-ink-faint mt-1">{t("web.register_username_help")}</p>
            </div>
            <div>
              <label className="text-sm font-semibold" htmlFor="email">
                {t("web.register_email")}
              </label>
              <input
                className="field mt-1"
                type="email"
                id="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            {page.has_password && (
              <div>
                <label className="text-sm font-semibold" htmlFor="current_password">
                  {t("web.settings_current_password")}
                </label>
                <input
                  className="field mt-1"
                  type="password"
                  id="current_password"
                  name="current_password"
                  autoComplete="current-password"
                />
              </div>
            )}
            <div>
              <label className="text-sm font-semibold" htmlFor="new_password">
                {t("web.settings_new_password")}
              </label>
              <input
                className="field mt-1"
                type="password"
                id="new_password"
                name="new_password"
                autoComplete="new-password"
                minLength={8}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={credentialsMutation.isPending}>
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
                  <div ref={widgetContainerRef} />
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
