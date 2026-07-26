/**
 * TSX port of apps/storefront/views/register.njk. register.njk overrides
 * base.njk's `nav`/`footer` blocks to empty — this page sits OUTSIDE
 * <Layout/> in App.tsx, so it reproduces base.njk's effective wrapper itself
 * (see LoginPage.tsx for the shared rationale). Markup/classes copied
 * verbatim apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { publicPost } from "../api/client";
import { t } from "../lib/i18n";
import Flash from "../components/shop/Flash";
import PasswordInput from "../components/shop/PasswordInput";
import Spinner from "../components/shop/Spinner";

/** Client-side twin of routes/auth.ts `safeNext` — see LoginPage.tsx. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

interface RegisterResponse {
  redirect: string;
}

export default function RegisterPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const ref = (params.get("ref") ?? "").slice(0, 16);

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");

  const registerMutation = useMutation({
    mutationFn: (vars: { fullName: string; username: string; email: string; password: string; password2: string }) =>
      publicPost<RegisterResponse>("/api/v1/auth/register", { ...vars, ref, next }),
    // Full page load (not navigate()) — the shell must re-serve with the
    // fresh CSRF token now that a session cookie exists.
    onSuccess: (data) => {
      window.location.assign(data.redirect);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    registerMutation.mutate({
      fullName,
      username,
      email,
      password: String(formData.get("password") ?? ""),
      password2: String(formData.get("password2") ?? ""),
    });
  }

  const error = registerMutation.error ? t((registerMutation.error as Error).message) : null;

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1">
      <div className="min-h-[100svh] flex items-center justify-center -my-8">
        <div className="w-full max-w-md card card-pad">
          <Link to="/" className="text-center block">
            <UserPlus className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.register_title")}</h1>
          </Link>

          {error && (
            <div className="mt-4">
              <Flash text={error} kind="error" />
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-semibold" htmlFor="fullName">
                {t("web.register_fullname")}
              </label>
              <input
                className="field mt-1"
                type="text"
                id="fullName"
                name="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
                required
                minLength={2}
                maxLength={100}
              />
            </div>
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
                required
                minLength={3}
                maxLength={32}
                // STO-014: must match LOGIN_USERNAME_RE (packages/db/src/crud/webauth.ts) — was
                // [a-zA-Z0-9_]+, letting an uppercase username pass client-side then 400 at the server.
                pattern="[a-z0-9_]+"
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
                required
              />
            </div>
            <div>
              <label className="text-sm font-semibold" htmlFor="password">
                {t("web.login_password")}
              </label>
              <PasswordInput
                className="field mt-1"
                id="password"
                name="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <div>
              <label className="text-sm font-semibold" htmlFor="password2">
                {t("web.register_password2")}
              </label>
              <PasswordInput
                className="field mt-1"
                id="password2"
                name="password2"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={registerMutation.isPending}>
              {registerMutation.isPending && <Spinner />}
              {t("web.register_submit")}
            </button>
            <div className="text-center text-sm">
              <Link to={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="text-pine hover:underline">
                {t("web.register_have_account")}
              </Link>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
