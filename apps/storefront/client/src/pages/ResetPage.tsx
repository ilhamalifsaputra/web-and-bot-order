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
import { useMutation, useQuery } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { apiGet, publicPost } from "../api/client";
import { t } from "../lib/i18n";
import Flash from "../components/shop/Flash";
import Spinner from "../components/shop/Spinner";

interface ResetResponse {
  redirect: string;
}

interface ResetCheckResponse {
  valid: boolean;
}

/** The "request a new link" escape hatch (T4) — shown whenever this page
 * cannot get the visitor to a successful reset, so a dead/expired/already-used
 * link is never a dead end. */
function RequestNewLinkNotice() {
  return (
    <div className="text-center text-sm mt-6">
      <Link to="/forgot" className="text-pine hover:underline">
        {t("web.reset_request_new")}
      </Link>
    </div>
  );
}

export default function ResetPage() {
  const { token = "" } = useParams<{ token: string }>();

  // T4: check the token BEFORE rendering a form that can never succeed —
  // GET /api/v1/auth/reset/:token/check is a read-only twin of the POST
  // below (apps/storefront/src/routes/apiAuth.ts), so the two can't disagree
  // on what counts as a usable link. A network/unexpected error here fails
  // open to the form rather than stranding the visitor on a false "invalid"
  // — the POST is still the authority and will reject a genuinely bad token.
  const checkQuery = useQuery({
    queryKey: ["reset-check", token],
    queryFn: () => apiGet<ResetCheckResponse>(`/api/v1/auth/reset/${token}/check`),
    retry: false,
  });
  const tokenKnownInvalid = checkQuery.data?.valid === false;

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

  const errorKey = resetMutation.error ? (resetMutation.error as Error).message : null;
  const error = errorKey ? t(errorKey) : null;
  // The token was accepted on load but got invalidated before submit (e.g. a
  // second tab already used it, or it expired mid-fill) — same dead end as
  // the on-load check failing, so it gets the same way out.
  const submitHitInvalidToken = errorKey === "web.reset_invalid";

  return (
    // tabIndex=-1: RouteEffects.tsx moves focus here on client-side
    // navigation (T15) — these auth routes sit outside <Layout/>, so each
    // needs its own focusable <main>.
    <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1" tabIndex={-1}>
      <div className="min-h-[100svh] flex items-center justify-center -my-8">
        <div className="w-full max-w-md card card-pad">
          <Link to="/" className="text-center block">
            <LockKeyhole className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.reset_title")}</h1>
          </Link>

          {checkQuery.isPending ? (
            <div className="mt-6 flex justify-center">
              <Spinner />
            </div>
          ) : tokenKnownInvalid ? (
            <>
              <div className="mt-4">
                <Flash text={t("web.reset_invalid")} kind="error" />
              </div>
              <RequestNewLinkNotice />
            </>
          ) : (
            <>
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

              {submitHitInvalidToken && <RequestNewLinkNotice />}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
