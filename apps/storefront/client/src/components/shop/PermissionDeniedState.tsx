/**
 * PermissionDeniedState — §16 "Permission denied": authenticated but forbidden
 * (an API 403). A 401 is a different case entirely and never reaches this
 * component — it still redirects to `/login?next=` upstream, unchanged.
 *
 * §16 requires this state to EXIST and to read differently from both Error
 * ("something broke, try again") and Not-found ("that thing isn't here"): this
 * one is "the thing is here, but it isn't yours to see". As of Fase 6 the
 * storefront has no confirmed 403 surface (Task 1 audit §F item 7), so this may
 * carry zero call sites until Fase 7 or later introduces one — that is
 * acceptable per the spec.
 */
import { ShieldX } from "lucide-react";
import { t } from "../../lib/i18n";
import StatusScreen, { type StatusScreenAction } from "./StatusScreen";

export interface PermissionDeniedStateProps {
  title?: string;
  description?: string;
  /** Defaults to a link back to the account home. */
  action?: StatusScreenAction;
  secondaryAction?: StatusScreenAction;
  bare?: boolean;
}

export default function PermissionDeniedState({
  title,
  description,
  action,
  secondaryAction,
  bare,
}: PermissionDeniedStateProps) {
  return (
    <StatusScreen
      bare={bare}
      icon={ShieldX}
      title={title ?? t("web.state_forbidden_title")}
      description={description ?? t("web.state_forbidden_body")}
      action={action ?? { label: t("web.account_title"), to: "/account" }}
      secondaryAction={secondaryAction}
    />
  );
}
