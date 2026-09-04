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
 * The centred, floor-height shell is `StatusScreen` (Fase 6 §16) — this
 * component composes it and layers on the one thing that is genuinely
 * empty-state-specific: an optional "you might like" product shelf
 * (`suggestions`) for the pages where shopping is the honest next step. Its
 * external API and rendered DOM are unchanged by that extraction.
 */
import { t } from "../../lib/i18n";
import ProductCard, { type ProductCardData } from "./ProductCard";
import StatusScreen, { type StatusScreenProps } from "./StatusScreen";

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
  icon: StatusScreenProps["icon"];
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

export default function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  bare = false,
  suggestions,
}: EmptyStateProps) {
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

  return (
    <StatusScreen
      icon={icon}
      title={title}
      description={description}
      action={action}
      secondaryAction={secondaryAction}
      bare={bare}
    >
      {/* `bare` means the caller already has its own card chrome around this
          (AccountPage's desktop "Recent Orders" widget), so the shelf just
          stacks directly underneath with its own top margin. */}
      {bare ? shelf && <div className="mt-8">{shelf}</div> : shelf}
    </StatusScreen>
  );
}
