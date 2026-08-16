/**
 * Single-page "instant buy" flow for a `checkoutFlow: "instant"` category
 * (the Digiflazz top-up pilot — plan §"UI/UX design — storefront instant-buy
 * page", Task 6). Renders instead of ProductPage's usual image/plan-picker
 * page for exactly these products (see ProductPage.tsx's branch), collapsing
 * the normal Product → Cart → Checkout hop into one page: account field(s) →
 * denomination → contact → payment → order summary, one submit button.
 *
 * Reuses the existing cart/checkout backend as-is — no new endpoint. As soon
 * as a denomination is picked (including the initial default), the page
 * syncs the buyer's SERVER-SIDE cart to hold exactly that one line at qty 1
 * (`syncCart` below), because `computeTotals`/the voucher-preview endpoint
 * both price the PERSISTED cart, not an ad-hoc line — the totals/payment
 * cards below are only ever showing what checkout would actually charge.
 * `syncCart` always clears every existing line first rather than trying an
 * optimistic add-and-catch-`cart_mixed_delivery`: this flow's cart is always
 * exactly one line, and posting the SAME denomination that's already there
 * would hit the server's same-line qty-increment path (packages/db/src/crud/
 * cart.ts addToCart) instead of leaving qty at 1 — clearing first side-steps
 * that regardless of what the cart already held (leftover browsing, a
 * previous partial attempt, or a genuine cart_mixed_delivery conflict).
 *
 * `page`/`totals`/voucher/method state mirrors CheckoutPage.tsx's own split
 * (see that file's top-of-file doc comment) with one relaxation: `page`/
 * `totals` are re-seeded from every fresh sync (CheckoutPage seeds `page`
 * only once), since picking a different denomination genuinely re-prices the
 * order — but the voucher input and the chosen payment method, once the buyer
 * has touched them, are never clobbered by a later resync.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { AlertTriangle, Package, ScrollText, ShieldCheck, Zap } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { CartPageData, CheckoutData, PlaceOrderResponse, ProductPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { t } from "../lib/i18n";
import { formatIdr } from "../lib/format";
import { fadeUp } from "../lib/motion";
import { rememberCodeEmailed } from "../lib/orderCodeEmailed";
import { allFieldsValid, isValidEmail } from "../lib/deliveryFields";
import { useIsDesktop } from "../lib/useMediaQuery";
import Breadcrumb from "../components/shop/Breadcrumb";
import DenominationCard from "../components/shop/DenominationCard";
import DeliveryFieldInput from "../components/shop/DeliveryFieldInput";
import Skeleton from "../components/shop/Skeleton";
import Spinner from "../components/shop/Spinner";
import PaymentMethodSelector, {
  anyMethodEnabled,
  defaultMethod,
  isIdrWalletSufficient,
  isUsdtWalletSufficient,
} from "../components/shop/PaymentMethodSelector";
import OrderSummaryCard from "../components/shop/OrderSummaryCard";
import { GuestContactCard } from "./CheckoutPage";
import ErrorPage from "./ErrorPage";

const revealProps = {
  variants: fadeUp,
  initial: "initial" as const,
  whileInView: "animate" as const,
  viewport: { once: true, margin: "-80px" },
};

/** Mirrors ProductPage.tsx's own `purchasable` (and DenominationCard's local
 * copy) — a denomination is buyable when it's in stock (auto) or a non-auto
 * delivery type (manual/manual_with_info never carry stock rows by design). */
function purchasable(d: { delivery_type: string; in_stock: boolean }): boolean {
  return d.delivery_type !== "auto" || d.in_stock;
}

/** Same fallback CheckoutPage.tsx applies to its own load failures — a
 * server-side i18n key renders through `t()`; anything else (a network
 * error, the API client's developer-facing "responded 500" fallback) becomes
 * the generic apology instead of leaking a raw string to a shopper. */
function humanError(message: string): string {
  return message.startsWith("web.") || message.startsWith("error.") ? t(message) : t("web.error_message");
}

export default function InstantBuyPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: ctx } = useShopContext();
  const isDesktop = useIsDesktop();

  // Same query key ProductPage.tsx's own useQuery uses for this endpoint —
  // when this page is reached via ProductPage's checkout_flow branch, the
  // product payload is already cached from ProductPage's own fetch, so this
  // resolves instantly instead of a second round trip.
  const { data, error } = useQuery({
    queryKey: ["product", slug],
    queryFn: () => apiGet<ProductPageData>(`/api/v1/pages/product/${slug}`),
    retry: false,
  });

  useDocumentTitle(data && ctx?.shop_name ? `${data.product.name} — ${ctx.shop_name}` : undefined);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [guestEmail, setGuestEmail] = useState("");
  const [voucherInput, setVoucherInput] = useState("");
  const [method, setMethod] = useState<string | null>(null);
  const [placeOrderErrorKey, setPlaceOrderErrorKey] = useState<string | null>(null);
  const [cartErrorKey, setCartErrorKey] = useState<string | null>(null);
  const [page, setPage] = useState<CheckoutData | null>(null);
  const [totals, setTotals] = useState<CheckoutData | null>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [slug]);

  const denominations = data?.denominations ?? [];
  const fallback = denominations.find((d) => d.in_stock) ?? denominations[0];
  const selected = denominations.find((d) => d.id === selectedId) ?? fallback;

  // Fetched only after a cart sync lands (see below) — the checkout payload
  // prices whatever the persisted cart currently holds, so reading it before
  // the sync would show stale or empty-cart totals.
  const {
    data: checkoutData,
    refetch: refetchCheckout,
  } = useQuery({
    queryKey: ["checkout"],
    queryFn: () => apiGet<CheckoutData>("/api/v1/checkout"),
    enabled: false,
    retry: false,
  });

  useEffect(() => {
    if (!checkoutData) return;
    const firstLoad = page === null;
    setPage(checkoutData);
    setTotals(checkoutData);
    if (firstLoad) {
      setVoucherInput(checkoutData.voucher_code ?? "");
      setMethod(defaultMethod(checkoutData));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutData]);

  // A different denomination has a different (possibly empty) field set —
  // stale answers from the last selection would otherwise ride along into a
  // customer_data payload that no longer matches the fields being shown.
  useEffect(() => {
    setAnswers({});
  }, [selected?.id]);

  const syncCart = useMutation({
    mutationFn: async (denominationId: number) => {
      const cart = await apiGet<CartPageData>("/api/v1/cart");
      for (const line of cart.items) {
        await apiPost<CartPageData>("/api/v1/cart/remove", { key: line.key });
      }
      return apiPost<CartPageData>("/api/v1/cart", { denomination_id: denominationId, qty: 1 });
    },
    onMutate: () => setCartErrorKey(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["context"] });
      void refetchCheckout();
    },
    onError: (err) => setCartErrorKey((err as Error).message),
  });

  // As soon as a denomination is selected/changes (including the initial
  // default pick), sync the server-side cart to hold exactly that one line.
  useEffect(() => {
    if (!selected) return;
    syncCart.mutate(selected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const previewMutation = useMutation({
    mutationFn: (voucherCode: string) =>
      apiPost<CheckoutData>("/api/v1/checkout/voucher/preview", { voucher_code: voucherCode }),
    onSuccess: (resp) => setTotals(resp),
  });

  function applyVoucher(): void {
    previewMutation.mutate(voucherInput);
  }

  function onVoucherKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    applyVoucher();
  }

  const needsInfo = selected?.delivery_type === "manual_with_info" && selected.additional_fields.length > 0;

  // Mirrors CheckoutPage.tsx's placeOrderMutation exactly (same endpoint,
  // same guest-mode full-reload vs. signed-in client nav, same order-code
  // email handoff) — customer_data is always a single-unit array here, since
  // InstantBuyPage never buys more than qty 1.
  const placeOrderMutation = useMutation({
    mutationFn: () =>
      apiPost<PlaceOrderResponse>("/api/v1/checkout", {
        method,
        voucher_code: voucherInput,
        customer_data: needsInfo ? [answers] : undefined,
        guest_email: page?.is_guest ? guestEmail.trim() : undefined,
      }),
    onSuccess: (resp) => {
      if (resp.email_sent === true) rememberCodeEmailed(resp.order_code, guestEmail.trim());
      if (resp.csrf_token || page?.is_guest) window.location.assign(resp.pay_url);
      else navigate(resp.pay_url);
    },
    onError: (err) => {
      setPlaceOrderErrorKey((err as Error).message);
      if (page?.is_guest) void queryClient.invalidateQueries({ queryKey: ["context"] });
    },
  });

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-4 w-48" />
        <div className="space-y-4">
          <Skeleton className="aspect-[4/3] w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    );
  }

  const { product, low_threshold } = data;
  const fx = ctx?.fx;
  if (!selected) return null;

  const readyToPay = Boolean(page && totals) && !syncCart.isPending;
  const infoValid = !needsInfo || allFieldsValid(selected.additional_fields, [answers], 1);
  const guestEmailValid = !page?.is_guest || isValidEmail(guestEmail);
  const anyMethod = totals
    ? anyMethodEnabled(totals) || isIdrWalletSufficient(totals) || isUsdtWalletSufficient(totals)
    : false;
  const submitBlocked = !readyToPay || !purchasable(selected) || !infoValid || !guestEmailValid || !anyMethod;
  const submitDisabled = submitBlocked || placeOrderMutation.isPending;

  return (
    <>
      <Breadcrumb
        items={[
          { label: t("web.nav_home"), href: "/" },
          { label: product.category_name, href: `/c/${product.category_slug}` },
          { label: product.name },
        ]}
      />

      {cartErrorKey && (
        <div className="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mb-5 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {humanError(cartErrorKey)}
        </div>
      )}
      {placeOrderErrorKey && !(page?.is_guest && placeOrderErrorKey === "web.guest_email_invalid") && (
        <div className="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mb-5">
          <AlertTriangle className="w-4 h-4" /> {humanError(placeOrderErrorKey)}
        </div>
      )}

      <form onSubmit={(e) => e.preventDefault()} className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
          {/* 1. Product header — image/title/description, ProductPage.tsx's
              own JSX pattern, folded into one card so it stacks with the rest
              of this page's sections. */}
          <div className="card card-pad">
            <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-sand">
              <picture className="block w-full h-full">
                {product.image_srcset && (
                  <source type="image/webp" srcSet={product.image_srcset} sizes="(max-width: 768px) 100vw, 600px" />
                )}
                <img
                  src={product.image}
                  alt={product.name}
                  loading="eager"
                  decoding="async"
                  width={800}
                  height={600}
                  className="w-full h-full object-cover"
                />
              </picture>
            </div>
            <h1 className="page-title text-2xl! sm:text-3xl! mt-4">{product.name}</h1>
            {product.description && (
              <div className="mt-3 text-sm leading-relaxed text-ink-soft whitespace-pre-line">
                {product.description}
              </div>
            )}
          </div>

          {/* 2. Account field(s) — the selected denomination's own
              additional_fields, single-unit (no qty stepper, no per-unit
              loop, no "copy to all units": this page always buys qty 1). */}
          {needsInfo && (
            <div className="card card-pad">
              <h2 className="section-title mb-1">{t("web.checkout_info_title")}</h2>
              <p className="text-xs text-ink-soft mb-3">{t("web.checkout_info_intro")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {selected.additional_fields.map((field) => (
                  <DeliveryFieldInput
                    key={field.key}
                    field={field}
                    inputId={`instant-${field.key}`}
                    value={answers[field.key] ?? ""}
                    onChange={(value) => setAnswers((prev) => ({ ...prev, [field.key]: value }))}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 3. Denomination grid — picking a plan re-syncs the server cart
              (see the effect above) so the totals/payment cards below always
              reflect exactly this one selection. */}
          <div className="card card-pad">
            <h2 className="section-title mb-3">{t("web.choose_plan")}</h2>
            <div className="grid gap-2.5">
              {denominations.map((d) => (
                <DenominationCard
                  key={d.id}
                  d={d}
                  fx={fx}
                  lowThreshold={low_threshold}
                  checked={d.id === selected.id}
                  onChange={() => setSelectedId(d.id)}
                />
              ))}
            </div>
          </div>

          {/* 4. Contact — guest visitors only, same field CheckoutPage.tsx uses. */}
          {page?.is_guest && (
            <GuestContactCard
              email={guestEmail}
              onChange={setGuestEmail}
              serverRejected={placeOrderErrorKey === "web.guest_email_invalid"}
            />
          )}

          {/* 5. Payment method. */}
          {page ? (
            <PaymentMethodSelector data={page} method={method} onSelect={setMethod} />
          ) : (
            <div className="card card-pad space-y-3" aria-busy="true" aria-label={t("web.loading")}>
              <Skeleton className="h-5 w-40" />
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          )}
        </div>

        {/* 6. Order summary — voucher + live totals + the single submit
            button (desktop inline here; mobile via the sticky bar below). */}
        {page && totals ? (
          <OrderSummaryCard
            totals={totals}
            method={method}
            fx={fx}
            voucherInput={voucherInput}
            onVoucherInputChange={setVoucherInput}
            onVoucherApply={applyVoucher}
            onVoucherKeyDown={onVoucherKeyDown}
            voucherPending={previewMutation.isPending}
            showDesktopSubmit={isDesktop}
            submitLabel={t("web.buy_now")}
            submitIcon={<Zap className="w-4 h-4" />}
            submitDisabled={submitDisabled}
            submitBlocked={submitBlocked}
            onSubmit={() => placeOrderMutation.mutate()}
            submitPending={placeOrderMutation.isPending}
          />
        ) : (
          <div className="card card-pad space-y-3" aria-busy="true" aria-label={t("web.loading")}>
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
      </form>

      {/* Description/trust section — ProductPage.tsx's own three optional
          blocks, unchanged. */}
      {(product.what_you_get || product.terms || product.warranty_note) && (
        <motion.section {...revealProps} className="mt-10 card card-pad">
          {[
            { key: "what_you_get", icon: Package, title: t("web.what_you_get"), body: product.what_you_get },
            { key: "terms", icon: ScrollText, title: t("web.product_terms"), body: product.terms },
            { key: "warranty", icon: ShieldCheck, title: t("web.warranty"), body: product.warranty_note },
          ]
            .filter((block) => Boolean(block.body))
            .map((block, index) => (
              <div key={block.key} className={index > 0 ? "mt-6 border-t border-line pt-6" : undefined}>
                <h2 className="flex items-center gap-2 font-display font-bold text-ink">
                  <block.icon className="w-4 h-4 text-pine shrink-0" aria-hidden="true" />
                  {block.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft whitespace-pre-line">{block.body}</p>
              </div>
            ))}
        </motion.section>
      )}

      {/* Reserved runway for the sticky mobile bar, ProductPage.tsx's own
          spacer-div technique (this page has content after the form, unlike
          CheckoutPage.tsx, so padding-on-form alone wouldn't cover it). */}
      {!isDesktop && <div aria-hidden="true" style={{ height: "calc(4.75rem + env(safe-area-inset-bottom))" }} />}

      {/* Sticky mobile total + submit — CheckoutPage.tsx's own bar verbatim
          (same classes/paddingBottom calc), reusing the same mutation and
          gating as the desktop submit button above: one purchase path. */}
      {!isDesktop && page && totals && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 px-4 pt-3 backdrop-blur-sm"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <div className="text-xs text-ink-soft">{t("web.order_total")}</div>
              <div className="text-base font-semibold text-pine truncate">
                {formatIdr(method === "qris" ? totals.qris_grand_total : totals.total)}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary ml-auto shrink-0"
              disabled={submitDisabled}
              style={submitBlocked ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
              onClick={() => placeOrderMutation.mutate()}
            >
              {placeOrderMutation.isPending && <Spinner />}
              {t("web.buy_now")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
