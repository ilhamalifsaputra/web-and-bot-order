/**
 * TSX port of apps/storefront/views/cart.njk — stepper, cart lines (qty
 * update / remove), summary, empty state. cart.njk has no inline <script>;
 * each line's plain qty field + Update button becomes a controlled input plus
 * a `POST /cart/update` mutation, same as the HTML form submit did. Markup/
 * classes copied verbatim apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw, ShoppingCart, Trash2 } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { CartLineView, CartPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import Price from "../components/shop/Price";
import Stepper from "../components/shop/Stepper";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

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

  const updateMutation = useMutation({
    mutationFn: (nextQty: number) => apiPost<CartPageData>("/api/v1/cart/update", { key: item.key, qty: nextQty }),
    onSuccess: onMutated,
  });
  const removeMutation = useMutation({
    mutationFn: () => apiPost<CartPageData>("/api/v1/cart/remove", { key: item.key }),
    onSuccess: onMutated,
  });

  return (
    <div className="p-4 flex items-center gap-3 sm:gap-4">
      <Link to={`/p/${item.product_slug}`} className="w-16 h-16 rounded-xl overflow-hidden bg-sand shrink-0">
        <img src={item.image} alt={item.name} loading="lazy" className="w-full h-full object-cover" />
      </Link>
      <div className="flex-1 min-w-0">
        <Link
          to={`/p/${item.product_slug}`}
          className="font-display text-sm font-semibold text-ink hover:text-pine line-clamp-2"
        >
          {item.name}
        </Link>
        <div className="mt-1">
          <Price value={item.unit_price} fx={fx} size="text-sm" />
        </div>
        {/* Non-auto lines never have stock rows by design (available is
            always 0), so this comparison is only meaningful for auto lines —
            gating on delivery_type avoids a permanent, misleading "0 left"
            warning on a legitimate manual/manual_with_info line. */}
        {item.delivery_type === "auto" && item.qty > item.available && (
          <div className="text-xs text-rust mt-1">{t("web.stock_left", { count: item.available })}</div>
        )}
      </div>
      <form className="flex items-center gap-1.5" onSubmit={(e) => e.preventDefault()}>
        <input
          type="number"
          name="qty"
          value={qty}
          min={0}
          max={99}
          className="field w-16! text-center"
          aria-label={t("web.qty")}
          onChange={(e) => setQty(clampCartQty(Number(e.target.value)))}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t("web.update")}
          disabled={updateMutation.isPending}
          onClick={() => updateMutation.mutate(qty)}
        >
          {updateMutation.isPending && <Spinner />}
          <RefreshCw className="w-4 h-4" />
        </button>
      </form>
      <form onSubmit={(e) => e.preventDefault()}>
        <button
          type="button"
          className="btn btn-ghost btn-sm text-rust"
          aria-label={t("web.remove")}
          disabled={removeMutation.isPending}
          onClick={() => removeMutation.mutate()}
        >
          {removeMutation.isPending && <Spinner />}
          <Trash2 className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

export default function CartPage() {
  const queryClient = useQueryClient();
  const { data: ctx } = useShopContext();
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

  function handleMutated(next: CartPageData): void {
    setCart(next);
    queryClient.invalidateQueries({ queryKey: ["context"] });
  }

  if (!cart) return null;

  const { items, subtotal } = cart;
  const fx = ctx?.fx;
  const cartCount = ctx?.cart_count ?? 0;

  return (
    <>
      <Stepper step={1} />
      <h1 className="page-title text-2xl! mb-5">
        {t("web.cart_title")}
        {cartCount > 0 ? ` (${cartCount})` : ""}
      </h1>

      {items.length > 0 ? (
        <div className="grid lg:grid-cols-3 gap-6 items-start">
          {/* Lines */}
          <div className="lg:col-span-2 card divide-y divide-line">
            {items.map((item) => (
              <CartLine key={item.key} item={item} fx={fx} onMutated={handleMutated} />
            ))}
          </div>

          {/* Summary */}
          <div className="card card-pad">
            <h2 className="section-title mb-3">{t("web.summary")}</h2>
            <div className="flex items-center justify-between text-sm py-1.5">
              <span className="text-ink-soft">{t("web.subtotal")}</span>
              <Price value={subtotal} fx={fx} size="text-sm" />
            </div>
            <p className="text-xs text-ink-faint mt-1">{t("web.discounts_at_checkout")}</p>
            <Link to="/checkout" className="btn btn-primary w-full mt-4">
              {t("web.to_checkout")} <ChevronRight className="w-4 h-4" />
            </Link>
            {/* STO-008: cart previously offered no way back to browsing —
                only "Continue to payment". */}
            <Link to="/" className="btn btn-ghost w-full mt-2">
              {t("web.continue_shopping")}
            </Link>
            {ctx && !ctx.customer && <p className="text-xs text-ink-faint mt-3">{t("web.login_to_checkout")}</p>}
          </div>
        </div>
      ) : (
        <div className="card card-pad text-center py-14">
          <ShoppingCart className="w-10 h-10 text-ink-faint mx-auto mb-3" />
          <p className="text-ink-soft">{t("web.cart_empty")}</p>
          <Link to="/" className="btn btn-primary mt-4">
            {t("web.hero_cta")}
          </Link>
        </div>
      )}
    </>
  );
}
