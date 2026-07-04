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
import { Bell, ShoppingCart, Zap } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, ProductPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatIdr } from "../lib/format";
import Breadcrumb from "../components/shop/Breadcrumb";
import Stars from "../components/shop/Stars";
import StockBadge from "../components/shop/StockBadge";
import DenominationCard from "../components/shop/DenominationCard";
import ErrorPage from "./ErrorPage";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

/** Qty input contract: 1..min(99, available). */
function clampQty(raw: number, available: number): number {
  const max = Math.max(1, Math.min(99, available));
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(Math.trunc(raw), max));
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

  // A different product slug means a different denomination set — start over,
  // same as a fresh page load would.
  useEffect(() => {
    setSelectedId(null);
    setQty(1);
  }, [slug]);

  const invalidateContext = () => queryClient.invalidateQueries({ queryKey: ["context"] });

  const addMutation = useMutation({
    mutationFn: (vars: { denomination_id: number; qty: number }) => apiPost<CartPageData>("/api/v1/cart", vars),
    onSuccess: () => {
      invalidateContext();
      navigate("/cart");
    },
  });
  const buyMutation = useMutation({
    mutationFn: (vars: { denomination_id: number; qty: number }) => apiPost<CartPageData>("/api/v1/cart", vars),
    onSuccess: () => {
      invalidateContext();
      navigate("/checkout");
    },
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

  const { product, denominations, reviews, low_threshold } = data;
  const fx = ctx?.fx;

  // Preselect the first in-stock plan, else the first plan — same order as
  // the script's `firstEnabled || radios[0]`.
  const fallback = denominations.find((d) => d.in_stock) ?? denominations[0];
  const selected = denominations.find((d) => d.id === selectedId) ?? fallback;
  if (!selected) return null;

  function selectDenomination(id: number, available: number): void {
    setSelectedId(id);
    setQty((prev) => clampQty(prev, available));
  }

  const buying = addMutation.isPending || buyMutation.isPending;

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
                  onChange={() => selectDenomination(d.id, d.available)}
                />
              ))}
            </div>
          </div>

          {/* Live summary — price/stock/warranty of the selected denomination. */}
          <div className="card card-pad mt-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="font-display font-semibold text-pine text-2xl">{formatIdr(selected.price)}</div>
              <div>
                <StockBadge available={selected.available} lowThreshold={low_threshold} />
              </div>
            </div>
            {fx && <div className="text-xs text-ink-faint mt-1.5">{t("web.usdt_note")}</div>}

            {selected.in_stock ? (
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
                    max={Math.max(1, Math.min(99, selected.available))}
                    className="field w-20! text-center"
                    onChange={(e) => setQty(clampQty(Number(e.target.value), selected.available))}
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
    </>
  );
}
