/**
 * TSX port of apps/storefront/views/reset.njk. reset.njk overrides base.njk's
 * `nav`/`footer` blocks to empty — this page sits OUTSIDE <Layout/> in
 * App.tsx, so it reproduces base.njk's effective wrapper itself (see
 * LoginPage.tsx for the shared rationale). Markup/classes copied verbatim
 * apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { publicPost } from "../api/client";
import { t } from "../lib/i18n";
import Flash from "../components/shop/Flash";
import Spinner from "../components/shop/Spinner";

interface ResetResponse {
  redirect: string;
}

export default function ResetPage() {
  const { token = "" } = useParams<{ token: string }>();

  const resetMutation = useMutation({
    mutationFn: (vars: { password: string; password2: string }) =>
      publicPost<ResetResponse>(`/api/v1/auth/reset/${token}`, vars),
    // Full page load (not navigate()) — the shell must re-serve with the
    // fresh CSRF token, matching the /login?reset=1 destination.
    onSuccess: (data) => {
      window.location.assign(data.redirect);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    resetMutation.mutate({
      password: String(formData.get("password") ?? ""),
      password2: String(formData.get("password2") ?? ""),
    });
  }

  const error = resetMutation.error ? t((resetMutation.error as Error).message) : null;

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1">
      <div className="min-h-[100svh] flex items-center justify-center -my-8">
        <div className="w-full max-w-md card card-pad">
          <Link to="/" className="text-center block">
            <LockKeyhole className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.reset_title")}</h1>
          </Link>

          {error && (
            <div className="mt-4">
              <Flash text={error} kind="error" />
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-semibold" htmlFor="password">
                {t("web.login_password")}
              </label>
              <input
                className="field mt-1"
                type="password"
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
              <input
                className="field mt-1"
                type="password"
                id="password2"
                name="password2"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={resetMutation.isPending}>
              {resetMutation.isPending && <Spinner />}
              {t("web.reset_submit")}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
