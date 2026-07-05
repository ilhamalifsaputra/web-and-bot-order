/**
 * TSX port of apps/storefront/views/forgot.njk. forgot.njk overrides
 * base.njk's `nav`/`footer` blocks to empty — this page sits OUTSIDE
 * <Layout/> in App.tsx, so it reproduces base.njk's effective wrapper itself
 * (see LoginPage.tsx for the shared rationale). Markup/classes copied
 * verbatim apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md).
 *
 * Behavioral delta vs the NJK: forgot.njk's GET handler rendered the
 * `unavailable` branch up front when SMTP isn't configured (routes/forgot.ts).
 * The JSON endpoint only reports `unavailable` on the POST response — there is
 * no GET twin to call on load — so this page always starts on the form and the
 * unavailable notice appears after submit instead of on load.
 */
import { type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { publicPost } from "../api/client";
import { t } from "../lib/i18n";
import Flash from "../components/shop/Flash";

/** base.njk's `data-submit-once` double-submit guard, ported (see LoginPage.tsx). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

interface ForgotResponse {
  sent: boolean;
  unavailable: boolean;
}

export default function ForgotPage() {
  const forgotMutation = useMutation({
    mutationFn: (email: string) => publicPost<ForgotResponse>("/api/v1/auth/forgot", { email }),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    forgotMutation.mutate(String(formData.get("email") ?? ""));
  }

  const error = forgotMutation.error ? t((forgotMutation.error as Error).message) : null;
  const result = forgotMutation.data;

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1">
      <div className="min-h-[100svh] flex items-center justify-center -my-8">
        <div className="w-full max-w-md card card-pad">
          <Link to="/" className="text-center block">
            <KeyRound className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.forgot_title")}</h1>
            <p className="text-sm text-ink-soft mt-2">{t("web.forgot_hint")}</p>
          </Link>

          {error ? (
            <div className="mt-6">
              <Flash text={error} kind="error" />
            </div>
          ) : result?.unavailable ? (
            <div className="mt-6">
              <Flash text={t("web.forgot_unavailable")} kind="error" />
            </div>
          ) : result?.sent ? (
            <div className="mt-6">
              <Flash text={t("web.forgot_sent")} kind="info" />
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <div>
                <label className="text-sm font-semibold" htmlFor="email">
                  {t("web.register_email")}
                </label>
                <input className="field mt-1" type="email" id="email" name="email" autoComplete="email" required />
              </div>
              <button type="submit" className="btn btn-primary w-full" disabled={forgotMutation.isPending}>
                {forgotMutation.isPending && <Spinner />}
                {t("web.forgot_submit")}
              </button>
            </form>
          )}

          <div className="text-center text-sm mt-6">
            <Link to="/login" className="text-pine hover:underline">
              {t("web.register_have_account")}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
