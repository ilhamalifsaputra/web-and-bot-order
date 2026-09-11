/**
 * TrustBadgeRow — `components.md` "Badge & chip → Trust row": a short list of
 * icon + short-label pairs used to state capabilities / guarantees (not
 * customer-count claims). Text is `text-sm`; the icon is passed in fully
 * formed so the caller controls its size and colour.
 *
 * The label colour is NOT baked in (the storefront's `cn` has no
 * `tailwind-merge`, so a baked `text-*` would fight a caller override by CSS
 * source order). Pass the text colour through `className` — `text-ink-soft` on
 * a light surface (the design-system default), an inverted tone on a dark
 * band. It cascades to the labels.
 *
 * Was hand-rolled and duplicated between `HomePage.tsx`'s hero strip and
 * `AuthBrandPanel.tsx`'s stacked list (audit action C1 "Trust row →
 * refactor/dedupe"). Business-agnostic: `items` carry plain nodes, no domain
 * types / routing / i18n — callers pass already-translated `label` strings and
 * already-styled `icon` elements.
 *
 *   orientation="row"    → wrapping horizontal strip (hero)
 *   orientation="column" → stacked list (narrow side panels)
 *
 * Surface-specific chrome (a top divider, an inverted text colour on a dark
 * band, top margin) is the caller's job — pass it through `className`, which
 * lands on the `<ul>` and, for the text colour, cascades to the labels.
 */
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface TrustBadge {
  /** Rendered as-is — the caller sizes and colours it, e.g.
   *  `<Zap className="h-4 w-4 text-grass" />`. */
  icon: ReactNode;
  label: ReactNode;
}

export interface TrustBadgeRowProps {
  items: TrustBadge[];
  orientation?: "row" | "column";
  className?: string;
}

export default function TrustBadgeRow({
  items,
  orientation = "row",
  className,
}: TrustBadgeRowProps) {
  return (
    <ul
      className={cn(
        "text-sm",
        orientation === "row" ? "flex flex-wrap gap-x-6 gap-y-2" : "space-y-3",
        className,
      )}
    >
      {items.map((badge, i) => (
        // `flex` (not `inline-flex`): in a `flex-wrap` row the parent lays the
        // items out anyway, and in a `column` stack a block-level row is what
        // `space-y-*` needs to actually separate them.
        <li key={i} className="flex items-center gap-1.5">
          {badge.icon}
          <span>{badge.label}</span>
        </li>
      ))}
    </ul>
  );
}
