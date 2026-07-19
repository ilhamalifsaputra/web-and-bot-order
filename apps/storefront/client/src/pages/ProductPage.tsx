/**
 * TSX port of apps/storefront/views/product.njk — image, denomination picker
 * (price/stock/qty-max/buy-vs-restock driven by the selected plan, replicating
 * the inline <script>'s `select()` behavior as React state instead of DOM
 * mutation), reviews. Markup/classes copied verbatim apart from the mechanical
 * Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, ShoppingCart, Zap } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, ProductPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatIdr } from "../lib/format";
import Breadcrumb from "../components/shop/Breadcrumb";
import Stars from "../components/shop/Stars";
import DenominationCard from "../components/shop/DenominationCard";
import FlashBadge, { FlashCountdown, FlashWasPrice } from "../components/shop/FlashBadge";
import ProductCard from "../components/shop/ProductCard";
import ErrorPage from "./ErrorPage";

/** Mirrors product.njk's inline script `select()` cls/txt branches for the
 * live summary's stock line — a `.chip` pill, NOT the shared `stock_badge`
 * macro (StockBadge's rounded-full/px-2.5/py-1/font-medium markup), which is
 * only used on the denomination cards themselves. Returns null for a
 * non-auto denomination — there's no stock concept for those, so showing a
 * false "Out of stock" chip next to a purchasable product would be wrong. */
function stockChip(available: number, lowThreshold: number, isAuto: boolean): { cls: string; text: string } | null {
  if (!isAuto) return null;
  if (available > lowThreshold) return { cls: "bg-grass-tint text-grass-dark", text: t("web.stock_available") };
  if (available > 0) return { cls: "bg-amberx-tint text-amberx", text: t("web.stock_left", { count: available }) };
  return { cls: "bg-rust-tint text-rust-dark", text: t("web.stock_out") };
}

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

/** Qty input contract: 1..min(99, available) for an auto denomination — a
 * non-auto denomination has no stock concept (available is always 0 by
 * design), so its cap is a flat 99 (matching the bot's MAX_QTY_PER_ORDER),
 * never tied to stock. */
function clampQty(raw: number, available: number, isAuto: boolean): number {
  const max = isAuto ? Math.max(1, Math.min(99, available)) : 99;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(Math.trunc(raw), max));
}

/** A denomination is purchasable when it's in stock (auto) OR when it's a
 * non-auto delivery type (manual/manual_with_info never have stock rows by
 * design — Task 2 skips stock reservation for them). Bug A fix (Task 6):
 * gating purely on `in_stock` made every manual-delivery product
 * permanently unbuyable on the storefront. */
function purchasable(d: { delivery_type: string; in_stock: boolean }): boolean {
  return d.delivery_type !== "auto" || d.in_stock;
}

export default function ProductPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: ctx } = useShopContext();
  const { data, error } = useQuery({
    queryKey: ["product", slug],
    queryFn: () => apiGet<ProductPageData>(`/api/v1/pages/product/${slug}`),
    retry: false,
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [cartErrorKey, setCartErrorKey] = useState<string | null>(null);

  // A different product slug means a different denomination set — start over,
  // same as a fresh page load would.
  useEffect(() => {
    setSelectedId(null);
    setQty(1);
  }, [slug]);

  const invalidateContext = () => queryClient.invalidateQueries({ queryKey: ["context"] });

  const addMutation = useMutation({
    mutationFn: (vars: { denomination_id: number; qty: number }) => apiPost<CartPageData>("/api/v1/cart", vars),
    onMutate: () => setCartErrorKey(null),
    onSuccess: () => {
      invalidateContext();
      navigate("/cart");
    },
    onError: (err) => setCartErrorKey((err as Error).message),
  });
  const buyMutation = useMutation({
    mutationFn: (vars: { denomination_id: number; qty: number }) => apiPost<CartPageData>("/api/v1/cart", vars),
    onMutate: () => setCartErrorKey(null),
    onSuccess: () => {
      invalidateContext();
      navigate("/checkout");
    },
    onError: (err) => setCartErrorKey((err as Error).message),
  });
  const restockMutation = useMutation({
    mutationFn: (denominationId: number) => apiPost(`/api/v1/restock/${denominationId}`, {}),
    onError: (err) => {
      if ((err as Error & { status?: number }).status === 401) {
        navigate(`/login?next=/p/${slug}`);
      }
    },
  });

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) return null;

  const { product, denominations, reviews, related_products, low_threshold } = data;
  const fx = ctx?.fx;

  // Preselect the first in-stock plan, else the first plan — same order as
  // the script's `firstEnabled || radios[0]`.
  const fallback = denominations.find((d) => d.in_stock) ?? denominations[0];
  const selected = denominations.find((d) => d.id === selectedId) ?? fallback;
  if (!selected) return null;

  function selectDenomination(id: number, available: number, isAuto: boolean): void {
    setSelectedId(id);
    setQty((prev) => clampQty(prev, available, isAuto));
  }

  const buying = addMutation.isPending || buyMutation.isPending;
  const selectedIsAuto = selected.delivery_type === "auto";
  const chip = stockChip(selected.available, low_threshold, selectedIsAuto);

  return (
    <>
      <Breadcrumb
        items={[
          { label: t("web.nav_home"), href: "/" },
          { label: product.category_name, href: `/c/${product.category_slug}` },
          { label: product.name },
        ]}
      />

      <div className="grid md:grid-cols-2 gap-6 lg:gap-10">
        {/* Image */}
        <div className="card overflow-hidden self-start">
          <div className="aspect-[4/3] bg-sand">
            <img src={product.image} alt={product.name} decoding="async" className="w-full h-full object-cover" />
          </div>
        </div>

        {/* Facts + denomination picker + actions */}
        <div id="product-detail">
          <h1 className="page-title text-2xl! sm:text-3xl!">{product.name}</h1>

          {product.description && (
            <div className="mt-3 text-sm text-ink-soft whitespace-pre-line">{product.description}</div>
          )}

          {/* Denomination cards — pick a plan (never a dropdown). The cheapest
              active denomination is preselected; selecting another updates the
              live price / stock / warranty and the checkout payload below. */}
          <div className="mt-6">
            <h2 className="section-title mb-3">{t("web.choose_plan")}</h2>
            <div id="denom-list" className="grid gap-2.5">
              {denominations.map((d) => (
                <DenominationCard
                  key={d.id}
                  d={d}
                  fx={fx}
                  lowThreshold={low_threshold}
                  checked={d.id === selected.id}
                  onChange={() => selectDenomination(d.id, d.available, d.delivery_type === "auto")}
                />
              ))}
            </div>
          </div>

          {/* Live summary — price/stock/warranty of the selected denomination. */}
          <div className="card card-pad mt-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-baseline gap-2 flex-wrap">
                {/* `selected.price` already carries the flash discount — the
                    struck figure beside it is the pre-sale one. */}
                <div className="font-display font-semibold text-pine text-2xl">{formatIdr(selected.price)}</div>
                {selected.flash && (
                  <FlashWasPrice value={selected.flash.base_price} endsAt={selected.flash.ends_at} />
                )}
              </div>
              {chip && (
                <div>
                  <span className={`chip ${chip.cls}`}>{chip.text}</span>
                </div>
              )}
            </div>
            {selected.flash && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <FlashBadge percent={selected.flash.discount_percent} endsAt={selected.flash.ends_at} />
                <FlashCountdown endsAt={selected.flash.ends_at} />
              </div>
            )}
            {fx && <div className="text-xs text-ink-faint mt-1.5">{t("web.usdt_note")}</div>}

            {cartErrorKey && (
              <div className="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mt-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" /> {t(cartErrorKey)}
              </div>
            )}

            {purchasable(selected) ? (
              // Buy Now / Add To Cart — both post the selected denomination_id.
              <form id="buy-form" className="mt-5 flex flex-wrap items-end gap-2" onSubmit={(e) => e.preventDefault()}>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-ink-soft" htmlFor="qty">
                    {t("web.qty")}
                  </label>
                  <input
                    id="qty"
                    type="number"
                    name="qty"
                    value={qty}
                    min={1}
                    max={selectedIsAuto ? Math.max(1, Math.min(99, selected.available)) : 99}
                    className="field w-20! text-center"
                    onChange={(e) => setQty(clampQty(Number(e.target.value), selected.available, selectedIsAuto))}
                  />
                </div>
                <button
                  type="button"
                  id="btn-cart"
                  className="btn btn-soft"
                  disabled={buying}
                  onClick={() => addMutation.mutate({ denomination_id: selected.id, qty })}
                >
                  {addMutation.isPending && <Spinner />}
                  <ShoppingCart className="w-4 h-4" /> {t("web.add_to_cart")}
                </button>
                <button
                  type="button"
                  id="btn-buy"
                  className="btn btn-primary"
                  disabled={buying}
                  onClick={() => buyMutation.mutate({ denomination_id: selected.id, qty })}
                >
                  {buyMutation.isPending && <Spinner />}
                  <Zap className="w-4 h-4" /> {t("web.buy_now")}
                </button>
              </form>
            ) : (
              // Out-of-stock restock CTA (works only when logged in).
              <form id="restock-form" className="mt-3" onSubmit={(e) => e.preventDefault()}>
                <button
                  type="button"
                  className="btn btn-soft"
                  disabled={restockMutation.isPending}
                  onClick={() => restockMutation.mutate(selected.id)}
                >
                  {restockMutation.isPending && <Spinner />}
                  <Bell className="w-4 h-4" /> {t("web.notify_restock")}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Reviews */}
      <section className="mt-10">
        <h2 className="section-title mb-3">{t("web.reviews")}</h2>
        {reviews.length > 0 ? (
          <div className="grid sm:grid-cols-2 gap-4">
            {reviews.map((r, i) => (
              <div key={i} className="card card-pad">
                <div className="flex items-center gap-2">
                  <Stars rating={r.rating} />
                  <span className="text-xs text-ink-faint">
                    {r.author} · {r.created_at_display}
                  </span>
                </div>
                {r.comment && <p className="text-sm text-ink-soft mt-2">{r.comment}</p>}
              </div>
            ))}
          </div>
        ) : (
          <div className="card card-pad text-center text-ink-faint py-10">{t("web.no_reviews")}</div>
        )}
      </section>

      {/* STO-011: same-category "You might also like" shelf — this product
          detail page had no cross-sell/discovery path back into the catalog. */}
      {related_products.length > 0 && (
        <section className="mt-10">
          <h2 className="section-title mb-3">{t("web.related_products")}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {related_products.map((p) => (
              <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
