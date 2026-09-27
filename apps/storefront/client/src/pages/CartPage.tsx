/**
 * TSX port of apps/storefront/views/cart.njk — stepper, cart lines (qty
 * update / remove), summary, empty state. cart.njk has no inline <script>;
 * each line's plain qty field + Update button becomes a controlled input plus
 * a `POST /cart/update` mutation, same as the HTML form submit did. Markup/
 * classes copied verbatim apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md) and the later mobile pass — the row
 * layout, the remove confirmation and the sticky checkout bar below are ours,
 * not the NJK's.
 *
 * Design-system migration (Fase 7c): the line-list and summary surfaces are
 * now `<Card>`, the qty field is `<Input>`, the Update/Remove icon controls
 * are `<IconButton>`, and the remove-confirm row's two buttons are `<Button>`
 * (danger/ghost) — all four keep the exact same DOM shape (a real `<label>`-
 * free `<input>`/`<button>` under the hood) the existing tests already query
 * by role/label text, so no state, mutation or gating logic moved. The mobile
 * sticky bar is now the shared `<StickyPurchaseBar>` (Task 11) instead of a
 * hand-rolled `fixed` div — it portals to `document.body`, fixing the same
 * `<main>`-containing-block bug Task 11's doc comment describes. Its CTA is
 * `onClick={() => navigate("/checkout")}` rather than a literal `<Link>`
 * (StickyPurchaseBar's primary action is always a button), so the "single
 * reachable place on mobile" test now looks for a `button`, not a `link` —
 * the destination and the "exactly one" property are unchanged, only the
 * element type. See deviations.md §13-checkout.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Package, RefreshCw, ShoppingBag, Trash2 } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { CartLineView, CartPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatPriceFor, formatUsdt } from "../lib/format";
import { useIsDesktop } from "../lib/useMediaQuery";
import { useSuggestedProducts } from "../lib/useSuggestedProducts";
import FlashBadge, { FlashWasPrice } from "../components/shop/FlashBadge";
import EmptyState from "../components/shop/EmptyState";
import Price from "../components/shop/Price";
import Skeleton from "../components/shop/Skeleton";
import Stepper from "../components/shop/Stepper";
import Spinner from "../components/shop/Spinner";
import StickyPurchaseBar from "../components/shop/StickyPurchaseBar";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import IconButton from "../components/ui/IconButton";
import Input from "../components/ui/Input";

/** Mirrors the input's own min="0" max="99" — the server's clampQty is still
 * the source of truth, this only keeps the field itself sane while typing. */
function clampCartQty(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(Math.trunc(raw), 99));
}

interface CartLineProps {
  item: CartLineView;
  fx: string | null | undefined;
  onMutated: (next: CartPageData) => void;
}

function CartLine({ item, fx, onMutated }: CartLineProps) {
  const [qty, setQty] = useState(item.qty);
  // Removal is destructive and used to fire on the first tap of a small icon
  // button — exactly the control a thumb hits by accident on a phone. The row
  // asks first instead, in place: an inline two-state control keeps the answer
  // next to the item being removed, where window.confirm would tear the user
  // out of the page and name no item at all.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (nextQty: number) => apiPost<CartPageData>("/api/v1/cart/update", { key: item.key, qty: nextQty }),
    onSuccess: onMutated,
  });
  const removeMutation = useMutation({
    mutationFn: () => apiPost<CartPageData>("/api/v1/cart/remove", { key: item.key }),
    onSuccess: onMutated,
  });

  return (
    /* One cramped row squeezed the title to a few characters at 320px, because
       the image, the qty field and two icon buttons all claimed fixed width
       from the same line. The row now breaks in two on a phone — identity
       (image + name + price) above, controls below — and only rejoins into the
       original single line from `sm` up, where there is room for it. */
    <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex items-start gap-3 min-w-0 flex-1 sm:items-center sm:gap-4">
        <Link to={`/p/${item.product_slug}`} className="w-16 h-16 rounded-xl overflow-hidden bg-sand shrink-0">
          {item.image ? (
            <img src={item.image} alt={item.name} loading="lazy" className="w-full h-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Package className="h-6 w-6 text-ink-faint" aria-hidden="true" />
            </div>
          )}
        </Link>
        <div className="flex-1 min-w-0">
          <Link
            to={`/p/${item.product_slug}`}
            className="font-display text-sm font-semibold text-ink transition-colors hover:text-pine line-clamp-2"
          >
            {item.name}
          </Link>
          {/* `unit_price` already carries the flash discount — the badge and
              the struck figure only explain where the price came from. */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Price value={item.unit_price} fx={fx} size="text-sm" />
            {item.flash && <FlashWasPrice value={item.flash.base_price} endsAt={item.flash.ends_at} />}
          </div>
          {item.flash && (
            <div className="mt-1">
              <FlashBadge percent={item.flash.discount_percent} endsAt={item.flash.ends_at} />
            </div>
          )}
          {/* Non-auto lines never have stock rows by design (available is
              always 0), so this comparison is only meaningful for auto lines —
              gating on delivery_type avoids a permanent, misleading "0 left"
              warning on a legitimate manual/manual_with_info line. */}
          {item.delivery_type === "auto" && item.qty > item.available && (
            <div className="text-xs text-rust mt-1">{t("web.stock_left", { count: item.available })}</div>
          )}
        </div>
      </div>
      {confirmingRemove ? (
        /* The confirmation takes over the whole control area rather than
           appearing beside it: with the qty field gone there is nothing else
           to aim at, so the question can't be answered by a mistap on a
           neighbouring control. `role="alert"` announces it the moment it
           replaces the trash button. */
        <div role="alert" className="flex flex-wrap items-center gap-2 shrink-0 sm:justify-end">
          <span className="text-xs text-ink-soft flex-1 min-w-0 sm:flex-none">{t("web.remove_confirm")}</span>
          <Button
            variant="danger"
            size="sm"
            disabled={removeMutation.isPending}
            onClick={() => removeMutation.mutate()}
          >
            {removeMutation.isPending && <Spinner />}
            {t("web.remove")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)}>
            {t("web.cancel")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 shrink-0 sm:justify-end sm:gap-3">
          <form className="flex items-center gap-1.5" onSubmit={(e) => e.preventDefault()}>
            <Input
              type="number"
              /* Phones pick the keyboard from inputMode, not from type=number —
                 without it the user gets the full QWERTY layout to type a digit
                 into a 64px-wide field. */
              inputMode="numeric"
              name="qty"
              value={qty}
              min={0}
              max={99}
              className="w-16! text-center"
              aria-label={t("web.qty")}
              onChange={(e) => setQty(clampCartQty(Number(e.target.value)))}
            />
            <IconButton
              size="sm"
              aria-label={t("web.update")}
              disabled={updateMutation.isPending}
              onClick={() => updateMutation.mutate(qty)}
            >
              {updateMutation.isPending && <Spinner />}
              <RefreshCw className="w-4 h-4" />
            </IconButton>
          </form>
          <IconButton
            size="sm"
            className="text-rust"
            aria-label={t("web.remove")}
            onClick={() => setConfirmingRemove(true)}
          >
            <Trash2 className="w-4 h-4" />
          </IconButton>
        </div>
      )}
    </div>
  );
}

export default function CartPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: ctx } = useShopContext();
  const isDesktop = useIsDesktop();
  const { data } = useQuery({
    queryKey: ["cart"],
    queryFn: () => apiGet<CartPageData>("/api/v1/cart"),
  });
  // Cart mutations respond with a fresh {items, subtotal} payload — apply it
  // directly instead of refetching ["cart"], same as the NJK re-rendering the
  // whole page after each 303.
  const [cart, setCart] = useState<CartPageData | null>(null);
  useEffect(() => {
    if (data) setCart(data);
  }, [data]);
  // Fetched only once the cart is known to be empty — never delays the
  // empty-cart card itself, which paints from `cart` alone.
  const { data: suggested } = useSuggestedProducts(!!cart && cart.items.length === 0);

  function handleMutated(next: CartPageData): void {
    setCart(next);
    queryClient.invalidateQueries({ queryKey: ["context"] });
  }

  if (!cart) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-6 w-56" />
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <Card padded={false} className="lg:col-span-2 divide-y divide-line">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-3 p-4">
                <Skeleton className="h-16 w-16 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-20" />
                </div>
              </div>
            ))}
          </Card>
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  const { items, subtotal } = cart;
  const fx = ctx?.fx;
  const currency = ctx?.currency ?? null;
  const cartCount = ctx?.cart_count ?? 0;

  return (
    <>
      {/* E3: an empty cart has nothing to check out, so showing "1 · Cart →
          2 · Payment → 3 · Done" above the empty state implied a checkout in
          progress. Only render the stepper once there's something in it. */}
      {items.length > 0 && <Stepper step={1} />}
      <h1 className="page-title text-2xl! mb-5">
        {t("web.cart_title")}
        {cartCount > 0 ? ` (${cartCount})` : ""}
      </h1>

      {items.length > 0 ? (
        <>
          {/* The bottom padding reserves the space the mobile checkout bar
              occupies, so the last line item stays readable instead of sitting
              underneath it. */}
          <div className={`grid lg:grid-cols-3 gap-6 items-start${isDesktop ? "" : " pb-28"}`}>
            {/* Lines */}
            <Card padded={false} className="lg:col-span-2 divide-y divide-line">
              {items.map((item) => (
                <CartLine key={item.key} item={item} fx={fx} onMutated={handleMutated} />
              ))}
            </Card>

            {/* Summary */}
            <Card>
              <h2 className="section-title mb-3">{t("web.summary")}</h2>
              <div className="flex items-center justify-between text-sm py-1.5">
                <span className="text-ink-soft">{t("web.subtotal")}</span>
                <Price value={subtotal} fx={fx} size="text-sm" />
              </div>
              <p className="text-xs text-ink-faint mt-1">{t("web.discounts_at_checkout")}</p>
              {/* On a phone the checkout call to action lives in the sticky bar
                  below, so the card must not repeat it — two identical links to
                  /checkout on one page is noise for anything reading the page
                  sequentially, and the card's copy is the one nobody scrolls to. */}
              {isDesktop && (
                <Link to="/checkout" className="btn btn-primary w-full mt-4">
                  {t("web.to_checkout")} <ChevronRight className="w-4 h-4" />
                </Link>
              )}
              {/* STO-008: cart previously offered no way back to browsing —
                  only "Continue to payment". */}
              <Link to="/" className="btn btn-ghost w-full mt-2">
                {t("web.continue_shopping")}
              </Link>
              {ctx && !ctx.customer && <p className="text-xs text-ink-faint mt-3">{t("web.login_to_checkout")}</p>}
            </Card>
          </div>

          {/* The summary card stacks below every line item on a phone, which
              put the only way to pay an entire cart's worth of scrolling away.
              The shared StickyPurchaseBar (Task 11) keeps the total and the
              call to action in reach at any scroll position, portaled out of
              <main> so it pins to the viewport rather than <main>'s bottom
              edge; desktop keeps the card, where the two-column grid already
              leaves the summary in view. Its CTA navigates programmatically
              (StickyPurchaseBar's action slot is a button, not a Link) — same
              /checkout destination as the desktop link above. */}
          {!isDesktop && (
            <StickyPurchaseBar
              ariaLabel={t("web.purchase_bar")}
              priceLabel={t("web.subtotal")}
              price={formatPriceFor(subtotal, currency, fx)}
              // Same rule as Price.tsx: the "≈ $" hint only applies to the
              // undecided (null) default — once a currency preference is
              // set, that IS the one figure shown, above.
              secondaryChip={
                currency === null && formatUsdt(subtotal, fx) ? (
                  <span className="text-xs text-ink-faint">{formatUsdt(subtotal, fx)}</span>
                ) : undefined
              }
              primaryAction={{
                label: (
                  <>
                    {t("web.to_checkout")} <ChevronRight className="w-4 h-4" />
                  </>
                ),
                onClick: () => navigate("/checkout"),
              }}
            />
          )}
        </>
      ) : (
        <EmptyState
          icon={ShoppingBag}
          title={t("web.cart_empty")}
          description={t("web.cart_empty_desc")}
          action={{ label: t("web.hero_cta"), to: "/products" }}
          suggestions={suggested ? { products: suggested.products, fx, lowThreshold: suggested.low_threshold } : undefined}
        />
      )}
    </>
  );
}
