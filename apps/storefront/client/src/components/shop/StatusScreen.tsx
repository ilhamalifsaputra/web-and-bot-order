/**
 * StatusScreen — the one shape every "the whole view is in a single state"
 * screen takes.
 *
 * §16 of the design prompt asks for a canonical component per state — Loading /
 * Empty / Error / Permission-denied / Not-found. Every one of them is the same
 * silhouette: a centred icon, a title, one optional line of explanation, and a
 * row of at most two actions. They differ only in icon, tone and copy. This is
 * that silhouette with nothing domain-specific in it:
 *
 *   - `EmptyState`            layers its `suggestions` product shelf on top;
 *   - `ErrorState`            passes `tone="danger"` + a retry `onClick`;
 *   - `NotFoundState` /
 *     `PermissionDeniedState`  pass a different icon + copy.
 *
 * Extracted from `EmptyState` (which still composes it) — the non-`bare` shape
 * used to hand-roll a floor-height centred box because `<main>` is a `flex-1`
 * column that stretches under a short card and leaves a few hundred px of dead
 * space beneath it (Task 10 / STO-E4). That box now lives here so every state
 * component inherits the same treatment.
 *
 * `bare` drops the card chrome and the centring box, for a caller that already
 * sits inside its own surface. `tone="danger"` tints the icon `rust`; the
 * default `neutral` keeps it `ink-faint`.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import Button from "../ui/Button";

export interface StatusScreenAction {
  label: string;
  /** In-app route. */
  to?: string;
  /** Real navigation (external / full page load). Wins over `to`. */
  href?: string;
  /** Run a handler instead of navigating — e.g. ErrorState's retry. Used only
   *  when neither `to` nor `href` is given. */
  onClick?: () => void;
}

export type StatusScreenTone = "neutral" | "danger";

export interface StatusScreenProps {
  icon: LucideIcon;
  title: string;
  /** Use a real heading when this state is the page's primary content. */
  titleAs?: "p" | "h1" | "h2";
  description?: string;
  action?: StatusScreenAction;
  secondaryAction?: StatusScreenAction;
  /** Render without the card chrome + centring box; the caller owns the surface. */
  bare?: boolean;
  /** `danger` tints the icon `rust` (error state); `neutral` (default) keeps it `ink-faint`. */
  tone?: StatusScreenTone;
  /** Extra content rendered as a sibling of the card, inside the centring box
   *  (EmptyState's suggestions shelf). */
  children?: ReactNode;
}

function ActionControl({ action, kind }: { action: StatusScreenAction; kind: "primary" | "ghost" }) {
  const className = `btn btn-${kind} w-full sm:w-auto`;
  if (action.href) {
    return (
      <a href={action.href} className={className}>
        {action.label}
      </a>
    );
  }
  if (action.to) {
    return (
      <Link to={action.to} className={className}>
        {action.label}
      </Link>
    );
  }
  // No destination: an in-place action (retry / reload handler).
  return (
    <Button variant={kind} className="w-full sm:w-auto" onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

export default function StatusScreen({
  icon: Icon,
  title,
  titleAs: Title = "p",
  description,
  action,
  secondaryAction,
  bare = false,
  tone = "neutral",
  children,
}: StatusScreenProps) {
  const card = (
    <div className={bare ? "px-4 py-12 text-center" : "card card-pad w-full py-10 text-center sm:py-12"}>
      <Icon
        className={`mx-auto h-12 w-12 ${tone === "danger" ? "text-rust" : "text-ink-faint"}`}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <Title className="mt-4 font-display text-base font-semibold text-ink">{title}</Title>
      {description && (
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">{description}</p>
      )}
      {(action || secondaryAction) && (
        // Full-width buttons on a phone (a centred 120px button is a small
        // target and reads as an afterthought), auto-width once there's room.
        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-3">
          {action && <ActionControl action={action} kind="primary" />}
          {secondaryAction && <ActionControl action={secondaryAction} kind="ghost" />}
        </div>
      )}
    </div>
  );

  if (bare) {
    return (
      <>
        {card}
        {children}
      </>
    );
  }

  return (
    // A floor height, not the full stretched height of `<main>` (that would
    // just move the void from below the card to below this box) — enough to
    // noticeably close the gap, while the block still grows past it naturally
    // once a caller renders something below (EmptyState's shelf).
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-10 py-6 sm:min-h-[420px]">
      {card}
      {children}
    </div>
  );
}
