/**
 * TSX port of apps/storefront/views/login.njk. login.njk overrides base.njk's
 * `nav`/`footer` blocks to empty — this page sits OUTSIDE <Layout/> in App.tsx,
 * so it reproduces base.njk's effective wrapper itself (just the <main> column;
 * #root already supplies the flex-column body base.njk put on <body>, see
 * src/index.css). Markup/classes copied verbatim apart from the mechanical
 * Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LogIn, Send } from "lucide-react";
import { apiGet, publicPost } from "../api/client";
import { t } from "../lib/i18n";
import Flash from "../components/shop/Flash";

/** Only ever a local path — client-side twin of routes/auth.ts `safeNext`
 * (open-redirect guard); the server re-checks this itself on every POST, this
 * copy only keeps the page's own links/hidden field sane. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

interface LoginResponse {
  redirect: string;
}

interface TelegramWidgetData {
  bot_username: string;
  auth_url: string;
}

export default function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const ref = params.get("ref") ?? "";
  // req.query.reset is truthy-checked server-side (any non-empty value), not
  // compared to the literal string "1" — mirror that rather than hardcoding.
  const resetDone = !!params.get("reset");
  const err = params.get("err");

  const [identifier, setIdentifier] = useState("");

  const loginMutation = useMutation({
    mutationFn: (vars: { identifier: string; password: string }) =>
      publicPost<LoginResponse>("/api/v1/auth/login", { ...vars, next }),
    // Full page load (not navigate()) — the shell must re-serve with the
    // fresh CSRF token now that a session cookie exists.
    onSuccess: (data) => {
      window.location.assign(data.redirect);
    },
  });

  const { data: widget } = useQuery({
    queryKey: ["telegram-widget", next, ref],
    queryFn: () => {
      const qs = new URLSearchParams({ next });
      if (ref) qs.set("ref", ref);
      return apiGet<TelegramWidgetData>(`/api/v1/auth/telegram-widget?${qs.toString()}`);
    },
  });

  // Renders the Telegram Login Widget's own <script> tag only once we know
  // the bot username — exactly login.njk's `{% if bot_username %}` gate.
  const widgetContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = widgetContainerRef.current;
    if (!container || !widget?.bot_username) return;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", widget.bot_username);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-radius", "12");
    script.setAttribute("data-auth-url", widget.auth_url);
    script.setAttribute("data-request-access", "write");
    container.appendChild(script);
    return () => {
      container.removeChild(script);
    };
  }, [widget?.bot_username, widget?.auth_url]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");
    loginMutation.mutate({ identifier, password });
  }

  const error = loginMutation.error ? t((loginMutation.error as Error).message) : null;
  const notice = resetDone
    ? t("web.login_reset_done")
    : err === "tg_failed"
      ? t("web.error_message")
      : err === "tg_unlinked"
        ? t("web.login_tg_unlinked")
        : null;

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1">
      <div className="min-h-[100svh] flex items-center justify-center -my-8">
        <div className="w-full max-w-md card card-pad">
          <Link to="/" className="text-center block">
            <LogIn className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.login_title")}</h1>
            <p className="text-sm text-ink-soft mt-2">{t("web.login_hint")}</p>
          </Link>

          {/* login.njk renders error and notice from two independent `{% if %}`s
              (not an elif) — both can show at once. */}
          {error && (
            <div className="mt-4">
              <Flash text={error} kind="error" />
            </div>
          )}
          {notice && (
            <div className="mt-4">
              <Flash text={notice} kind="info" />
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-semibold" htmlFor="identifier">
                {t("web.login_identifier")}
              </label>
              <input
                className="field mt-1"
                type="text"
                id="identifier"
                name="identifier"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label className="text-sm font-semibold" htmlFor="password">
                {t("web.login_password")}
              </label>
              <input
                className="field mt-1"
                type="password"
                id="password"
                name="password"
                autoComplete="current-password"
                required
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={loginMutation.isPending}>
              {loginMutation.isPending && <Spinner />}
              {t("web.login_submit")}
            </button>
            <div className="flex items-center justify-between text-sm">
              <Link to="/forgot" className="text-pine hover:underline">
                {t("web.forgot_link")}
              </Link>
              <Link
                to={next !== "/" ? `/register?next=${encodeURIComponent(next)}` : "/register"}
                className="text-pine hover:underline"
              >
                {t("web.register_cta")}
              </Link>
            </div>
          </form>

          {widget?.bot_username && (
            <>
              <div className="mt-6 flex items-center gap-3 text-xs text-ink-faint">
                <span className="flex-1 border-t border-line" />
                {t("web.login_or")}
                <span className="flex-1 border-t border-line" />
              </div>
              <div className="mt-4 rounded-xl border border-line bg-paper px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-3 flex items-center justify-center gap-1.5">
                  <Send className="w-3.5 h-3.5" /> {t("web.login_telegram")}
                </p>
                <div className="flex justify-center" ref={widgetContainerRef}>
                  <noscript className="text-xs text-ink-faint">{t("web.login_telegram")}</noscript>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
