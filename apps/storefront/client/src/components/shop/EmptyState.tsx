/**
 * The one shape every "nothing here yet" screen takes.
 *
 * The shop had eight different ones: some with an icon, some a bare sentence,
 * one buried in a `<td colSpan={5}>` — and several that told the visitor a list
 * was empty without offering any way out of it. An empty state is a dead end
 * unless it names a next step, so `action` is what a caller should almost
 * always pass.
 *
 * Mirrors the web-admin `EmptyState` API (icon / title / description / action,
 * apps/web-admin/client/src/components/shared/EmptyState.tsx) so the two apps
 * stay recognisably one product, rendered with the storefront's own `.btn`
 * classes and react-router `Link` instead of shadcn + onClick.
 */
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

export interface EmptyStateAction {
  label: string;
  /** In-app route. Use `href` instead for a real navigation. */
  to?: string;
  href?: string;
}

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Renders without the card chrome, for use inside a surface that already
   *  has its own (e.g. a panel that is itself a card). */
  bare?: boolean;
}

function ActionLink({ action, variant }: { action: EmptyStateAction; variant: "btn-primary" | "btn-ghost" }) {
  const className = `btn ${variant} w-full sm:w-auto`;
  return action.href ? (
    <a href={action.href} className={className}>
      {action.label}
    </a>
  ) : (
    <Link to={action.to!} className={className}>
      {action.label}
    </Link>
  );
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  bare = false,
}: EmptyStateProps) {
  return (
    <div className={bare ? "px-4 py-12 text-center" : "card card-pad py-12 text-center sm:py-16"}>
      <Icon className="mx-auto h-12 w-12 text-ink-faint" strokeWidth={1.5} aria-hidden="true" />
      <p className="mt-4 font-display text-base font-semibold text-ink">{title}</p>
      {description && (
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">{description}</p>
      )}
      {(action || secondaryAction) && (
        // Full-width buttons on a phone (a centred 120px button is a small
        // target and reads as an afterthought), auto-width once there's room.
        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-3">
          {action && <ActionLink action={action} variant="btn-primary" />}
          {secondaryAction && <ActionLink action={secondaryAction} variant="btn-ghost" />}
        </div>
      )}
    </div>
  );
}
