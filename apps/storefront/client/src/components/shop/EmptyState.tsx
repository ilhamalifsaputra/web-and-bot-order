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
 *
 * Task 10 (E4): a bare empty-state card used to sit high in `<main>` with a
 * few hundred px of dead space beneath it on a tall viewport — `<main>` is a
 * `flex-1` column, so it stretches to fill whatever the header/footer leave
 * behind and the short card never claimed any of that height. The non-`bare`
 * shape now centres itself in a floor-height box instead of hugging the top,
 * and can optionally carry a small product shelf (`suggestions`) for the
 * pages where shopping is genuinely the next step — see ProductCard.tsx and
 * pages/*.tsx for the callers that pass it.
 */
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";
import ProductCard, { type ProductCardData } from "./ProductCard";

export interface EmptyStateAction {
  label: string;
  /** In-app route. Use `href` instead for a real navigation. */
  to?: string;
  href?: string;
}

/** A small "you might like" shelf rendered below the card — optional, and
 * never what gates the card's own render (see the `EmptyStateProps.suggestions`
 * doc). Capped at 4 here regardless of how many the caller passes in, so no
 * call site can accidentally turn this into a second full grid. */
export interface EmptyStateSuggestions {
  products: ProductCardData[];
  fx: string | null | undefined;
  lowThreshold: number;
}

const SUGGESTIONS_LIMIT = 4;

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Renders without the card chrome, for use inside a surface that already
   *  has its own (e.g. a panel that is itself a card). */
  bare?: boolean;
  /**
   * Optional product shelf shown below the card, for the pages where the
   * honest fix for "empty" is "here's something to buy" (an empty cart, no
   * orders yet, a search with no results) rather than a page where selling
   * would be tone-deaf (a support inbox, a failed checkout load). Works under
   * `bare` too (AccountPage's desktop "Recent Orders" widget wants a shelf
   * without the centred, min-height card chrome it's already nested inside) —
   * only the outer centring box is skipped there, not the shelf itself.
   * Caller is responsible for not fetching this data in a way that blocks the
   * empty state's own render (see lib/useSuggestedProducts.ts): pass
   * `undefined`/no products until it resolves and the shelf simply appears
   * once it does.
   */
  suggestions?: EmptyStateSuggestions;
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
  suggestions,
}: EmptyStateProps) {
  const card = (
    // sm:py-16 tightened to sm:py-12 (STO-E4): the card's own padding was part
    // of what made the "void beneath" read as excessive, on top of `<main>`
    // stretching underneath it — icon size/type scale are untouched.
    <div className={bare ? "px-4 py-12 text-center" : "card card-pad w-full py-10 text-center sm:py-12"}>
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

  // `suggestions?.products ?? []` isn't enough on its own: a caller can pass
  // a truthy `suggestions` whose `products` field is missing or malformed
  // (an older/mocked payload, or a page fetching the wrong shape) — guard the
  // whole thing so a shelf can never crash the card it sits below.
  const shelfProducts = Array.isArray(suggestions?.products) ? suggestions.products.slice(0, SUGGESTIONS_LIMIT) : [];
  const shelf = shelfProducts.length > 0 && (
    <div className="w-full">
      <h2 className="mb-4 text-center text-sm font-semibold uppercase tracking-wide text-pine">
        {t("web.related_products")}
      </h2>
      <div
        className={`grid gap-4 ${
          shelfProducts.length === 1 ? "mx-auto max-w-xs" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
        }`}
      >
        {shelfProducts.map((p) => (
          <ProductCard key={p.slug} p={p} fx={suggestions!.fx} lowThreshold={suggestions!.lowThreshold} />
        ))}
      </div>
    </div>
  );

  if (bare) {
    // No centring box: `bare` means the caller already has its own card
    // chrome around this (AccountPage's desktop "Recent Orders" widget), so
    // stacking the shelf directly underneath is enough.
    return (
      <>
        {card}
        {shelf && <div className="mt-8">{shelf}</div>}
      </>
    );
  }

  return (
    // A floor height, not the full stretched height of `<main>` (that would
    // just move the void from below the card to below this box) — enough to
    // noticeably close the gap the card used to leave, while the block still
    // grows past it naturally once a suggestions shelf is present below.
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-10 py-6 sm:min-h-[420px]">
      {card}
      {shelf}
    </div>
  );
}
