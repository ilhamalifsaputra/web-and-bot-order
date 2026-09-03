/**
 * TSX port of apps/storefront/views/reset.njk. reset.njk overrides base.njk's
 * `nav`/`footer` blocks to empty — this page sits OUTSIDE <Layout/> in
 * App.tsx, so it reproduces base.njk's effective wrapper itself (see
 * LoginPage.tsx for the shared rationale). Markup/classes copied verbatim
 * apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md).
 *
 * Task 16: shares its <main> with <AuthBrandPanel/> — see AuthBrandPanel.tsx
 * for why it sits after the card in the JSX despite rendering to its left on
 * desktop.
 *
 * Task 15 (design-system migration, Fase 7d): see LoginPage.tsx's header
 * comment for the §4 template-mismatch writeup and deviations.md §15-auth
 * for the one-time record, which also covers this page's specific
 * token-check state mapping (kept close to its current shape rather than
 * forced onto `LoadingState`/`ErrorState` — see that entry for why). The
 * password/confirm fields are now `<FormField>` + `<PasswordInput>` (this
 * page previously used raw `<input type="password">` with no show/hide
 * toggle — PasswordInput adds it, a pure UI affordance, no payload change),
 * the submit is `<Button>`, and every banner is `<Alert variant="banner">`.
 * The `GET .../reset/:token/check` pre-check, `tokenKnownInvalid`/
 * `submitHitInvalidToken` logic, and the "request a new link" escape hatch
 * are byte-for-byte unchanged.
 */
import { type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { apiGet, publicPost } from "../api/client";
import { t } from "../lib/i18n";
import AuthBrandPanel from "../components/AuthBrandPanel";
import PasswordInput from "../components/shop/PasswordInput";
import Spinner from "../components/shop/Spinner";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import FormField from "../components/ui/FormField";

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
      <div className="min-h-[100svh] flex flex-col items-center justify-center gap-8 -my-8 lg:flex-row lg:items-center lg:justify-center lg:gap-16">
        <Card className="w-full max-w-md">
          <Link to="/" className="text-center block">
            <LockKeyhole className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.reset_title")}</h1>
          </Link>

          {checkQuery.isPending ? (
            <div className="mt-6 flex justify-center" aria-busy="true" aria-label={t("web.loading")}>
              <Spinner />
            </div>
          ) : tokenKnownInvalid ? (
            <>
              <Alert variant="banner" tone="error" className="mt-4">
                {t("web.reset_invalid")}
              </Alert>
              <RequestNewLinkNotice />
            </>
          ) : (
            <>
              {error && (
                <Alert variant="banner" tone="error" className="mt-4">
                  {error}
                </Alert>
              )}

              <form onSubmit={onSubmit} className="mt-6 space-y-4">
                <FormField label={t("web.login_password")} htmlFor="password">
                  <PasswordInput
                    id="password"
                    name="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                </FormField>
                <FormField label={t("web.register_password2")} htmlFor="password2">
                  <PasswordInput
                    id="password2"
                    name="password2"
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                </FormField>
                <Button type="submit" variant="primary" fullWidth disabled={resetMutation.isPending}>
                  {resetMutation.isPending && <Spinner />}
                  {t("web.reset_submit")}
                </Button>
              </form>

              {submitHitInvalidToken && <RequestNewLinkNotice />}
            </>
          )}
        </Card>

        <AuthBrandPanel className="max-w-md" />
      </div>
    </main>
  );
}
