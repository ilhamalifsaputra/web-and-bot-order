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
 * FormData at submit like every other auth form. The Telegram section uses
 * the same native-looking `TelegramLoginButton` button as LoginPage, but its
 * `authUrl` is the fixed server route (not fetched) and the gate is
 * `!tg_linked && bot_id` per settings.njk. The form markup has since been
 * reworked for the phone — consistent label/field spacing, mobile keyboard
 * hints, and the credentials error moved next to the button that produced
 * it — but every endpoint, payload and validation rule is unchanged from
 * the port.
 *
 * Task 17 (design-system migration, Fase 7f): two-card layout kept; the
 * cards are now `<Card>`, the credential fields `<FormField>` + `<Input>` /
 * `<PasswordInput>`, the submit a `<Button>`, and every status banner
 * (`?saved=1` / `?linked=1` / `?err=…`, the credentials-POST error, and the
 * "linked as {name}" confirmation) an `<Alert variant="banner">`. The
 * server-driven Telegram-link redirect flow, the `/credentials` payload, the
 * `window.location.assign` reload and the `401` guard are untouched. No
 * canonical-label fix applied: `web.settings_save` = "Simpan / Save" already
 * matches `business-adaptation.md`'s CTA Register row for "Save account
 * credential changes" (distinct from the order-info "Simpan perubahan / Save
 * changes" row) — see deviations.md §17-support.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api/client";
import type { SettingsData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { currentLang, t } from "../lib/i18n";
import { tError } from "../lib/errors";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import FormField from "../components/ui/FormField";
import Input from "../components/ui/Input";
import CurrencyToggle from "../components/layout/CurrencyToggle";
import PasswordInput from "../components/shop/PasswordInput";
import Spinner from "../components/shop/Spinner";
import TelegramLoginButton from "../components/shop/TelegramLoginButton";

interface CredentialsVars {
  username: string;
  email: string;
  current_password: string;
  new_password: string;
}

export default function SettingsPage() {
  const [params] = useSearchParams();
  const { data: ctx } = useShopContext();
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

  if (!page) return null;

  const queryErrorText =
    params.get("err") === "tg_taken"
      ? t("web.settings_tg_taken")
      : params.get("err") === "tg_invalid"
        ? t("web.error_message")
        : null;
  // A failed credentials POST is about the form, so it renders inside the
  // form; only the redirect-flow (?err=…) messages, which belong to the
  // Telegram link round-trip, stay at page level. The two can never be
  // showing at once — a failed POST never navigates.
  const mutationErrorText = credentialsMutation.error ? tError(credentialsMutation.error) : null;
  const saved = Boolean(params.get("saved"));
  const linked = Boolean(params.get("linked"));

  return (
    <>
      <h1 className="page-title mb-6">{t("web.settings_title")}</h1>

      {queryErrorText && (
        <Alert variant="banner" tone="error" className="max-w-md">
          {queryErrorText}
        </Alert>
      )}
      {saved && (
        <Alert variant="banner" tone="info" className="max-w-md">
          {t("web.settings_saved")}
        </Alert>
      )}
      {linked && (
        <Alert variant="banner" tone="info" className="max-w-md">
          {t("web.settings_tg_done")}
        </Alert>
      )}

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <Card>
          <h2 className="font-display text-lg font-semibold mb-4">{t("web.settings_login_section")}</h2>
          {/* `space-y-5` rather than `space-y-4`: with a help line hanging off
              the username field, tighter gaps made the help text look like it
              belonged to the field below it. */}
          <form onSubmit={onSubmit} className="space-y-5">
            <div>
              <FormField label={t("web.register_username")} htmlFor="username">
                <Input
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
              </FormField>
              <p id="username_help" className="text-xs text-ink-faint mt-1.5">
                {t("web.register_username_help")}
              </p>
            </div>
            <FormField label={t("web.register_email")} htmlFor="email">
              <Input
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
            </FormField>
            {page.has_password && (
              <FormField label={t("web.settings_current_password")} htmlFor="current_password">
                <PasswordInput
                  id="current_password"
                  name="current_password"
                  autoComplete="current-password"
                />
              </FormField>
            )}
            <FormField label={t("web.settings_new_password")} htmlFor="new_password">
              <PasswordInput
                id="new_password"
                name="new_password"
                autoComplete="new-password"
                minLength={8}
              />
            </FormField>
            {/* Next to the button that produced it: on a phone a failure
                announced at the top of the page is off-screen by the time the
                thumb reaches Save. `<Alert variant="banner" tone="error">`
                carries `role="alert"` itself, so it is spoken when it appears
                rather than only on the next focus move. */}
            {mutationErrorText && (
              <Alert variant="banner" tone="error">
                {mutationErrorText}
              </Alert>
            )}
            <Button
              type="submit"
              variant="primary"
              className="w-full sm:w-auto"
              disabled={credentialsMutation.isPending}
            >
              {credentialsMutation.isPending && <Spinner />}
              {t("web.settings_save")}
            </Button>
          </form>
        </Card>

        {/* Task 5: currency + a read-only glance at the language setting.
            Currency persists via the same Task-4 endpoint the Navbar/
            MobileDrawer switcher uses (useCurrencySwitch, inside
            CurrencyToggle) — language stays the server-driven /lang
            round-trip, so it's shown here for reference only, not editable. */}
        <Card>
          <h2 className="font-display text-lg font-semibold mb-4">{t("web.settings_preferences_section")}</h2>
          <div className="space-y-4">
            <div>
              <p className="field-label mb-1.5">{t("web.currency_label")}</p>
              <CurrencyToggle currency={ctx?.currency ?? null} fx={ctx?.fx} variant="stacked" />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-soft">{t("web.lang_label")}</span>
              <span className="font-medium">{t(`web.lang_name_${currentLang()}`)}</span>
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="font-display text-lg font-semibold mb-4">{t("web.settings_tg_section")}</h2>
          {page.tg_linked ? (
            <Alert variant="banner" tone="success">
              {t("web.settings_tg_linked", { name: page.tg_name })}
            </Alert>
          ) : (
            <>
              <p className="text-sm text-ink-soft mb-4">{t("web.settings_tg_hint")}</p>
              {page.bot_id ? (
                <TelegramLoginButton botId={page.bot_id} authUrl="/account/settings/link-telegram" />
              ) : (
                <p className="text-sm text-ink-faint">{t("web.settings_tg_unconfigured")}</p>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
