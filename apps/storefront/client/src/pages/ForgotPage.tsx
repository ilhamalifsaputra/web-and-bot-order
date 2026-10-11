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
 *
 * Task 16: shares its <main> with <AuthBrandPanel/> — see AuthBrandPanel.tsx
 * for why it sits after the card in the JSX despite rendering to its left on
 * desktop.
 *
 * Task 15 (design-system migration, Fase 7d): see LoginPage.tsx's header
 * comment for the §4 template-mismatch writeup and deviations.md §15-auth
 * for the one-time record. Email field is `<FormField>` + `<Input>`, submit
 * is `<Button>`; the three outcome banners are `<Alert variant="banner">`
 * with the tone the brief calls for — `warning` for the SMTP-unavailable
 * branch, `success` for the sent confirmation, `error` for a request
 * failure. No fetch/payload/copy changed, only presentation.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { publicPost } from "../api/client";
import AuthBrandPanel from "../components/AuthBrandPanel";
import Spinner from "../components/shop/Spinner";
import Alert from "../components/ui/Alert";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import FormField from "../components/ui/FormField";
import Input from "../components/ui/Input";
import { t } from "../lib/i18n";

interface ForgotResponse {
  sent: boolean;
  unavailable: boolean;
}

export default function ForgotPage() {
  const request = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ForgotResponse | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  useEffect(() => () => { request.current = null; }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const formData = new FormData(event.currentTarget);
    const token = Symbol();
    request.current = token;
    setPending(true);
    setFailure(null);
    try {
      const response = await publicPost<ForgotResponse>("/api/v1/auth/forgot", { email: String(formData.get("email") ?? "") });
      if (request.current === token) setResult(response);
    } catch (error) {
      if (request.current === token) setFailure(error as Error);
    } finally {
      if (request.current === token) {
        request.current = null;
      }
      setPending(false);
    }
  }

  const error = failure ? t(failure.message) : null;

  return (
    // tabIndex=-1: RouteEffects.tsx moves focus here on client-side
    // navigation (T15) — these auth routes sit outside <Layout/>, so each
    // needs its own focusable <main>.
    <main className="max-w-6xl mx-auto px-4 py-8 lg:px-6 flex-1" tabIndex={-1}>
      <div className="min-h-[100svh] flex flex-col items-center justify-center gap-8 -my-8 lg:flex-row lg:items-center lg:justify-center lg:gap-16">
        <Card className="w-full max-w-md">
          <Link to="/" className="text-center block">
            <KeyRound className="w-8 h-8 text-pine mx-auto" />
            <h1 className="font-display text-xl font-semibold mt-3">{t("web.forgot_title")}</h1>
            <p className="text-sm text-ink-soft mt-2">{t("web.forgot_hint")}</p>
          </Link>

          {error ? (
            <Alert variant="banner" tone="error" className="mt-6">
              {error}
            </Alert>
          ) : result?.unavailable ? (
            <Alert variant="banner" tone="warning" className="mt-6">
              {t("web.forgot_unavailable")}
            </Alert>
          ) : result?.sent ? (
            <Alert variant="banner" tone="success" className="mt-6">
              {t("web.forgot_sent")}
            </Alert>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <FormField label={t("web.register_email")} htmlFor="email">
                <Input id="email" type="email" name="email" autoComplete="email" required />
              </FormField>
              <Button type="submit" variant="primary" fullWidth disabled={pending}>
                {pending && <Spinner />}
                {t("web.forgot_submit")}
              </Button>
            </form>
          )}

          <div className="text-center text-sm mt-6">
            <Link to="/login" className="text-pine hover:underline">
              {t("web.register_have_account")}
            </Link>
          </div>
        </Card>

        <AuthBrandPanel className="max-w-md" />
      </div>
    </main>
  );
}
