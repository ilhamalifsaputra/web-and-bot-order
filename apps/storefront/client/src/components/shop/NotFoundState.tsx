/**
 * NotFoundState — §16 "Not found", the in-page variant: a data-bound page that
 * rendered its shell and then had its own fetch resolve to a 404 (a product,
 * category, order or ticket slug that does not exist).
 *
 * Distinct from `EmptyState` on purpose: EmptyState says "there is nothing here
 * *yet*, here is how to add some"; this says "the specific thing you asked for
 * does not exist". It is NOT `pages/ErrorPage.tsx` either — that is the
 * `*`-route catch-all the SPA shell serves with a real HTTP 404 for a route
 * that never matched.
 */
import { PackageX } from "lucide-react";
import { t } from "../../lib/i18n";
import StatusScreen, { type StatusScreenAction } from "./StatusScreen";

export interface NotFoundStateProps {
  title?: string;
  description?: string;
  /** Defaults to a link back to the home page. */
  action?: StatusScreenAction;
  secondaryAction?: StatusScreenAction;
  bare?: boolean;
}

export default function NotFoundState({
  title,
  description,
  action,
  secondaryAction,
  bare,
}: NotFoundStateProps) {
  return (
    <StatusScreen
      bare={bare}
      icon={PackageX}
      title={title ?? t("web.state_notfound_title")}
      description={description ?? t("web.state_notfound_body")}
      action={action ?? { label: t("web.back_home"), to: "/" }}
      secondaryAction={secondaryAction}
    />
  );
}
