/**
 * Shown in place of a page an order-recovery (/track) session cannot open (H5,
 * UI-states audit): says why, links back to the recovered order, and offers the
 * one way out — logging out, which reloads the shop as a normal visitor.
 */
import { useMutation } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { Link } from "react-router-dom";
import { apiPost } from "../../api/client";
import { humanError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Card from "../ui/Card";

export default function RecoveryScopeNotice({ orderCode }: { orderCode: string }) {
  const logout = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/api/v1/auth/logout", {}),
    // Full reload: clears the scoped session's CSRF meta with it.
    onSuccess: () => window.location.assign("/"),
  });
  return (
    <Card className="mx-auto max-w-md text-center">
      <LockKeyhole className="mx-auto mb-3 h-8 w-8 text-ink-faint" aria-hidden="true" />
      <h1 className="section-title mb-2">{t("shop.recovery_scope_title")}</h1>
      <p className="mb-4 text-sm text-ink-soft">{t("shop.recovery_scope_body")}</p>
      {logout.error && (
        <Alert variant="banner" tone="error">{humanError(logout.error)}</Alert>
      )}
      <div className="flex flex-wrap justify-center gap-3">
        <Link to={`/account/orders/${encodeURIComponent(orderCode)}`} className="btn btn-ghost">
          {t("shop.recovery_scope_view")}
        </Link>
        <Button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {t("shop.recovery_scope_logout")}
        </Button>
      </div>
    </Card>
  );
}
