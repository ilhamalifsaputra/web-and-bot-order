/**
 * TSX port of apps/storefront/views/register.njk. register.njk overrides
 * base.njk's `nav`/`footer` blocks to empty — this page sits OUTSIDE
 * <Layout/> in App.tsx, so it reproduces base.njk's effective wrapper itself
 * (see LoginPage.tsx for the shared rationale). Markup/classes copied
 * verbatim apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md).
 *
 * Task 16: shares its <main> with <AuthBrandPanel/> — see AuthBrandPanel.tsx
 * for why it sits after the card in the JSX despite rendering to its left on
 * desktop. Note this page also has its own inline Terms/Privacy links in the
 * consent notice below the password fields (T11) — those are independent of
 * the panel's policy links and intentionally duplicate them.
 *
 * Task 15 (design-system migration, Fase 7d): see LoginPage.tsx's header
 * comment for the §4 template-mismatch writeup (no OTP step exists in this
 * app) and deviations.md §15-auth for the one-time record. Fields are now
 * `<FormField>` + `<Input>`/`<PasswordInput>`, the submit is `<Button>`, the
 * error banner is `<Alert variant="banner" tone="error">`. The T11
 * Terms/Privacy notice keeps its exact copy and non-checkbox nature — only
 * its paragraph colour moves from `ink-faint` to `ink-soft` (no test asserts
 * that class, unlike the password-hint paragraph below, which keeps
 * `ink-faint` because RegisterPage.test.tsx pins it).
 */
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { publicPost } from "../api/client";
import { t } from "../lib/i18n";
import AuthBrandPanel from "../components/AuthBrandPanel";
import PasswordInput from "../components/shop/PasswordInput";
import Spinner from "../components/shop/Spinner";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import FormField from "../components/ui/FormField";
import Input from "../components/ui/Input";

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
    //
    // T5: a bare `data.redirect` landed the new customer on their
    // destination with zero acknowledgement that anything happened — the
    // "Masuk" → "Akun" header swap was the only (easy-to-miss) signal. Since
    // this is a full page load, no in-memory Toast state survives it — the
    // `welcome=1` marker rides on the redirect URL instead (same pattern as
    // /login?reset=1 below) and Layout.tsx reads it once on mount to show the
    // confirmation, then strips it from the URL.
    onSuccess: (data) => {
      const separator = data.redirect.includes("?") ? "&" : "?";
      window.location.assign(`${data.redirect}${separator}welcome=1`);
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
    // tabIndex=-1: RouteEffects.tsx moves focus here on client-side
    // navigation (T15) — these auth routes sit outside <Layout/>, so each
    // needs its own focusable <main>.
    <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1" tabIndex={-1}>
      <div className="min-h-[100svh] flex flex-col items-center justify-center gap-8 -my-8 lg:flex-row lg:items-center lg:justify-center lg:gap-16">
        <Card className="w-full max-w-md">
          <Link to="/" className="text-center block">
            <UserPlus className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.register_title")}</h1>
          </Link>

          {error && (
            <Alert variant="banner" tone="error" className="mt-4">
              {error}
            </Alert>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <FormField label={t("web.register_fullname")} htmlFor="fullName">
              <Input
                id="fullName"
                type="text"
                name="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
                required
                minLength={2}
                maxLength={100}
              />
            </FormField>
            <div>
              <FormField label={t("web.register_username")} htmlFor="username">
                <Input
                  id="username"
                  type="text"
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
              </FormField>
              <p className="text-xs text-ink-faint mt-1">{t("web.register_username_help")}</p>
            </div>
            <FormField label={t("web.register_email")} htmlFor="email">
              <Input
                id="email"
                type="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </FormField>
            <div>
              <FormField label={t("web.login_password")} htmlFor="password">
                <PasswordInput
                  id="password"
                  name="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </FormField>
              {/* T10: the 8-character minimum used to only surface as the
                  browser's native validation bubble after a failed submit —
                  same hint style/position as the username field's above. */}
              <p className="text-xs text-ink-faint mt-1">{t("web.register_password_help")}</p>
            </div>
            <FormField label={t("web.register_password2")} htmlFor="password2">
              <PasswordInput
                id="password2"
                name="password2"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </FormField>
            {/* T11: a passive notice, not a blocking consent checkbox — signup
                stays a single required step, this just makes sure the two
                policies are reachable from the form that binds you to them. */}
            <p className="text-center text-xs text-ink-soft">
              {t("web.register_terms_prefix")}{" "}
              <Link to="/terms" className="text-pine hover:underline">
                {t("web.terms_title")}
              </Link>{" "}
              {t("web.register_terms_and")}{" "}
              <Link to="/privacy" className="text-pine hover:underline">
                {t("web.privacy_title")}
              </Link>
              .
            </p>
            <Button type="submit" variant="primary" fullWidth disabled={registerMutation.isPending}>
              {registerMutation.isPending && <Spinner />}
              {t("web.register_submit")}
            </Button>
            <div className="text-center text-sm">
              <Link to={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="text-pine hover:underline">
                {t("web.register_have_account")}
              </Link>
            </div>
          </form>
        </Card>

        <AuthBrandPanel className="max-w-md" />
      </div>
    </main>
  );
}
