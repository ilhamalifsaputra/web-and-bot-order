/**
 * Single-page "instant buy" flow for a `checkoutFlow: "instant"` category
 * (the Digiflazz top-up pilot — plan §"UI/UX design — storefront instant-buy
 * page", Task 6). Renders instead of ProductPage's usual image/plan-picker
 * page for exactly these products (see ProductPage.tsx's branch), collapsing
 * the normal Product → Cart → Checkout hop into one page: account field(s) →
 * denomination → contact → payment → order summary, one submit button.
 *
 * CART-FREE BY DESIGN (final-review fix N2). This is a direct purchase: the
 * selected denomination is priced and charged as an ad-hoc single line and
 * never enters the cart table, so this page reads and writes NO cart state at
 * all — no `GET /api/v1/cart`, no `POST /api/v1/cart`, no
 * `POST /api/v1/cart/remove`. It used to write its selection into the
 * server-side cart (clearing every line already there first) purely so the
 * cart-based `computeTotals` could see it, which meant merely OPENING a top-up
 * product page silently destroyed whatever the visitor had been shopping for.
 * Two purpose-built endpoints replace that (apps/storefront/src/routes/
 * apiTopup.ts):
 *   - `POST /api/v1/topup/preview` — the exact same payload `GET /api/v1/checkout`
 *     returns (so `CheckoutData`, OrderSummaryCard and PaymentMethodSelector are
 *     unchanged), priced from `{ denomination_id, qty }` instead of a cart. Both
 *     re-pricing triggers this page has — a denomination switch and a voucher
 *     application — go through it, so they can never disagree.
 *   - `POST /api/v1/topup/order` — creates the order from that same single
 *     denomination (`createOrderDirect`, the rail the Telegram bot has always
 *     used), returning the same `{ order_code, pay_url, csrf_token?, email_sent? }`
 *     body as `POST /api/v1/checkout`.
 * Nothing about a visitor's real cart is touched at any point, whether they
 * complete the purchase or abandon it.
 *
 * `page`/`totals`/voucher/method state mirrors CheckoutPage.tsx's own split
 * (see that file's top-of-file doc comment) with one relaxation: `page`/
 * `totals` are re-seeded from every fresh preview (CheckoutPage seeds `page`
 * only once), since picking a different denomination genuinely re-prices the
 * order — but the voucher input and the chosen payment method, once the buyer
 * has touched them, are never clobbered by a later re-price.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Package, ScrollText, ShieldCheck, Zap } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import { useIdempotentPost } from "../api/idempotency";
import type { CheckoutData, PlaceOrderResponse, ProductPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { currentLang, t } from "../lib/i18n";
import { humanError } from "../lib/errors";
import { formatPriceFor } from "../lib/format";
import { fadeUp } from "../lib/motion";
import { rememberCodeEmailed } from "../lib/orderCodeEmailed";
import { allFieldsValid, isValidEmail } from "../lib/deliveryFields";
import { useIsWideDesktop } from "../lib/useMediaQuery";
import Breadcrumb from "../components/shop/Breadcrumb";
import DefaultThumb from "../components/shop/DefaultThumb";
import DenominationCard from "../components/shop/DenominationCard";
import StickyPurchaseBar from "../components/shop/StickyPurchaseBar";
import DeliveryFieldInput from "../components/shop/DeliveryFieldInput";
import Alert from "../components/ui/Alert";
import Skeleton from "../components/shop/Skeleton";
import Spinner from "../components/shop/Spinner";
import PaymentMethodSelector, {
  anyMethodEnabled,
  defaultMethod,
  isIdrWalletSufficient,
  isMethodValid,
  isUsdtWalletSufficient,
} from "../components/shop/PaymentMethodSelector";
import OrderSummaryCard, { idrRailPriceAndPay } from "../components/shop/OrderSummaryCard";
import { GuestContactCard } from "./CheckoutPage";
import ErrorPage from "./ErrorPage";
import Button from "../components/ui/Button";

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

/** Whole-branch review F4a: the local `humanError(message)` this page and
 * CheckoutPage each carried is now `lib/errors.ts`'s, taking the ERROR so the
 * figures its copy quotes ({min}, {limit}, {max}) can be substituted instead of
 * reaching the buyer as braces. Same i18n-key-vs-developer-string rule as before. */

/** I-3, widened: shared by both re-pricing triggers this page has — a
 * denomination switch (the checkoutData effect below) and a voucher
 * application (previewMutation's onSuccess) can each re-price the order
 * enough that the previously-selected method (most often a wallet-credit row
 * whose sufficiency is total-dependent) no longer appears in
 * PaymentMethodSelector's rows for the new totals. Both call sites reduce to
 * this one check so `method` never rides along pointing at a row nothing
 * renders any more. */
function revalidatedMethod(data: CheckoutData, prev: string | null): string | null {
  return prev !== null && isMethodValid(data, prev) ? prev : null;
}

export default function InstantBuyPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: ctx } = useShopContext();
  // Tailwind's lg breakpoint (1024px) limits the hybrid bar to mobile.
  // The primary submit stays in normal flow at every viewport.
  const isDesktop = useIsWideDesktop();

  // Same query key ProductPage.tsx's own useQuery uses for this endpoint —
  // when this page is reached via ProductPage's checkout_flow branch, the
  // product payload is already cached from ProductPage's own fetch, so this
  // resolves instantly instead of a second round trip.
  const { data, error } = useQuery({
    queryKey: ["product", slug, ctx?.currency ?? null, ctx?.lang, ctx?.pricing_context],
    queryFn: () => apiGet<ProductPageData>(`/api/v1/pages/product/${slug}`),
    retry: false,
  });

  useDocumentTitle(data && ctx?.shop_name ? `${data.product.name} — ${ctx.shop_name}` : undefined);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [checkoutAttempted, setCheckoutAttempted] = useState(false);
  const [guestEmail, setGuestEmail] = useState("");
  const [voucherInput, setVoucherInput] = useState("");
  const [method, setMethod] = useState<string | null>(null);
  // The rejection itself, not just its key — the figures its copy quotes ride on
  // the Error (`errorArgs`, F4a). The derived key below is what the two
  // guest-email branches compare against.
  const [placeOrderError, setPlaceOrderError] = useState<unknown>(null);
  const placeOrderErrorKey = placeOrderError instanceof Error ? placeOrderError.message : null;
  const [page, setPage] = useState<CheckoutData | null>(null);
  const [storedTotals, setTotals] = useState<CheckoutData | null>(null);
  const [pricedContext, setPricedContext] = useState("");
  const [voucherBusyContext, setVoucherBusyContext] = useState<string | null>(null);
  const [appliedVoucher, setAppliedVoucher] = useState("");
  const submitLock = useRef(false);
  const voucherRequest = useRef(0);
  const [primaryElement, setPrimaryElement] = useState<HTMLButtonElement | null>(null);
  const [primaryVisible, setPrimaryVisible] = useState(true);

  useEffect(() => {
    if (!primaryElement || isDesktop || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setPrimaryVisible(entry?.isIntersecting ?? true), { threshold: 0 });
    observer.observe(primaryElement);
    return () => observer.disconnect();
  }, [primaryElement, isDesktop]);

  useEffect(() => {
    setSelectedId(null);
  }, [slug]);

  const denominations = data?.denominations ?? [];
  const fallback = denominations.find((d) => d.in_stock) ?? denominations[0];
  const selected = denominations.find((d) => d.id === selectedId) ?? fallback;
  const needsInfo = (selected?.additional_fields.length ?? 0) > 0;
  const fieldConfigKey = JSON.stringify(selected?.additional_fields ?? []);
  const configValid = selected?.input_configuration_valid !== false;
  const previewContext = JSON.stringify([slug, selected?.id, ctx?.currency, ctx?.pricing_context, ctx?.lang]);
  // Updated during render so responses cannot slip through before reset effects.
  const currentPreviewContext = useRef(previewContext);
  currentPreviewContext.current = previewContext;
  const totals = pricedContext === previewContext ? storedTotals : null;
  const voucherPending = voucherBusyContext === previewContext;

  // Live totals for the SELECTED denomination — an ad-hoc line priced by the
  // server, with no cart anywhere in the loop. Keyed on the denomination id, so
  // picking a different plan re-prices automatically (this replaces the
  // cart-sync effect the old design fired off the same trigger), and React
  // Query only ever surfaces the response belonging to the current key — a
  // slow answer for an abandoned selection can't overwrite a newer one.
  const previewQuery = useQuery({
    queryKey: ["topup-preview", selected?.id, ctx?.currency, ctx?.pricing_context, ctx?.lang],
    queryFn: () =>
      apiPost<CheckoutData>("/api/v1/topup/preview", { denomination_id: selected!.id, qty: 1 }),
    enabled: selected != null && configValid,
    retry: false,
    // Batch 2 review finding: this query's request body never carries the
    // applied voucher code (that re-price goes through previewMutation
    // below instead, which is what actually gets charged) — with React
    // Query's default staleTime:0, an unrelated background refetch (window
    // focus is the realistic trigger: the buyer alt-tabs to copy their
    // in-game id) would silently re-fire this voucher-LESS request, and the
    // effect below applies whatever it returns to `totals` unconditionally.
    // The buyer would then see the discount vanish from the displayed total
    // while still being charged it (voucherInput is unaffected and still
    // sent at submit) — the exact preview-vs-charge divergence this whole
    // feature exists to prevent. This query only needs to refetch when the
    // selection changes (a new queryKey) or the voucher mutation below
    // supersedes it; staleTime: Infinity stops every other automatic
    // refetch (focus, reconnect, remount) without needing per-trigger flags.
    staleTime: Infinity,
  });
  const checkoutData = previewQuery.data;
  // Surfaced as a banner AND as a submit blocker below: React Query keeps the
  // last successful `data` when a later refetch fails, so without this the page
  // would keep showing (and let the buyer pay against) totals for a selection
  // the server never priced.
  const previewErrorKey = previewQuery.error ? (previewQuery.error as Error).message : null;

  useEffect(() => {
    if (!checkoutData) return;
    const firstLoad = page === null;
    setPage(checkoutData);
    setTotals(checkoutData);
    setPricedContext(previewContext);
    setAppliedVoucher(checkoutData.voucher_code ?? "");
    if (firstLoad) {
      setVoucherInput(checkoutData.voucher_code ?? "");
      setMethod(defaultMethod(checkoutData));
    } else {
      // I-3: a denomination switch can re-price the order enough that the
      // previously-selected method no longer appears in
      // PaymentMethodSelector's rows for the new totals. Left alone,
      // `method` would keep pointing at a row nothing renders any more —
      // no radio shows checked, yet `anyMethod` below only asks whether
      // SOME method is offered, so the submit button could stay enabled
      // with a selection the page no longer offers. Clear it so the buyer
      // is prompted to pick again instead. (The voucher-driven flip side of
      // this same re-price lives in previewMutation's onSuccess below.)
      setMethod((prev) => revalidatedMethod(checkoutData, prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutData, previewContext]);

  useEffect(() => {
    voucherRequest.current += 1;
    setVoucherBusyContext(null);
    setAppliedVoucher("");
    setVoucherInput("");
  }, [previewContext]);

  // A different denomination has a different (possibly empty) field set —
  // stale answers from the last selection would otherwise ride along into a
  // customer_data payload that no longer matches the fields being shown.
  useEffect(() => {
    setAnswers({});
    setTouched({});
    setCheckoutAttempted(false);
  }, [selected?.id, fieldConfigKey]);

  // Task 7: live KokinPay nickname-check lookup on the account field(s),
  // debounced ~800ms and cancelled on every keystroke via AbortController so
  // a stale response can never overwrite a newer one. `user_id`/`server_id`
  // are the field-key convention Task 4's wizard/manual-entry template both
  // pre-fill (DeliveryTypeSection.tsx's AUTO_DELIVERY_FIELDS_TEMPLATE) — this
  // is how the endpoint's `id`/`server` request fields get their values.
  // A denomination whose fields were hand-edited to different keys simply
  // never has `answers["user_id"]` populated, so no lookup fires and the
  // field behaves exactly as it does today — same silent no-op as every
  // other non-available outcome below.
  const [nicknameCheck, setNicknameCheck] = useState<{
    pending: boolean;
    nickname: string | null;
    notFound: boolean;
  }>({ pending: false, nickname: null, notFound: false });

  const activeInputsJson = JSON.stringify(Object.fromEntries((selected?.additional_fields ?? []).map((field) => [field.key, (answers[field.key] ?? "").trim()])));

  useEffect(() => {
    // Any change to the account field(s) (including a denomination switch,
    // which resets `answers` above) invalidates whatever the last check
    // showed — clear immediately rather than let a stale nickname linger
    // next to a since-edited id.
    setNicknameCheck({ pending: false, nickname: null, notFound: false });
    if (!needsInfo || !selected || !configValid) return;
    // Code review: firing on every non-empty id, with no minimum length and
    // no regard for a not-yet-filled server/zone field, produced a
    // premature "not found" hint on a CORRECT id for games (e.g. Mobile
    // Legends) whose lookup requires a server value — the buyer pauses
    // after typing their id but before the zone digits land, and gets a
    // transient false "not found" against the feature's own trust-building
    // intent. MIN_ACCOUNT_ID_LENGTH filters out obviously-incomplete ids;
    // the server-field check below only applies when this denomination's
    // own field template actually has a `server_id` field (some games have
    // no server/zone concept at all, and must not be gated on one).
    const playerInputs = JSON.parse(activeInputsJson) as Record<string, string>;
    if (!allFieldsValid(selected.additional_fields, [playerInputs], 1)) return;

    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => {
      setNicknameCheck((prev) => ({ ...prev, pending: true }));
      apiPost<{ available: boolean; valid?: boolean; nickname?: string | null }>(
        "/api/v1/topup/check-account",
        { denomination_id: selected.id, player_inputs: playerInputs },
        { signal: controller.signal },
      )
        .then((res) => {
          if (cancelled) return;
          if (res.available && res.valid && res.nickname) {
            setNicknameCheck({ pending: false, nickname: res.nickname, notFound: false });
          } else if (res.available && res.valid === false) {
            setNicknameCheck({ pending: false, nickname: null, notFound: true });
          } else {
            // available: false — no check configured, no credentials, or a
            // network/HTTP failure. Never surfaced: the field looks and
            // behaves exactly as it does today.
            setNicknameCheck({ pending: false, nickname: null, notFound: false });
          }
        })
        .catch(() => {
          // A cancelled (AbortError) or otherwise failed request — same
          // silent no-op, never an error state shown to the buyer.
          if (cancelled) return;
          setNicknameCheck({ pending: false, nickname: null, notFound: false });
        });
    }, 800);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [needsInfo, selected, activeInputsJson, configValid]);

  // Applying a voucher re-prices the SAME ad-hoc line the query above prices,
  // through the SAME endpoint — one pricing implementation, so a voucher can
  // never be quoted against something other than the plan on screen.
  const previewMutation = useMutation({
    mutationFn: (request: { code: string; denominationId: number; context: string; sequence: number }) =>
      apiPost<CheckoutData>("/api/v1/topup/preview", {
        denomination_id: request.denominationId,
        qty: 1,
        voucher_code: request.code,
      }),
    onSuccess: (resp, request) => {
      if (request.context !== currentPreviewContext.current || request.sequence !== voucherRequest.current) return;
      setTotals(resp);
      setPricedContext(request.context);
      setAppliedVoucher(resp.error_key ? "" : resp.voucher_code ?? request.code);
      // I-3, widened: a voucher application re-prices `totals` directly
      // (never touching `checkoutData`, which is what the effect above
      // keys on), so that effect alone can't catch a re-price triggered
      // this way — e.g. swapping in a smaller-discount code after
      // wallet_idr was already selected for a larger-discount total. Same
      // check, same clear, just fired from this trigger too.
      setMethod((prev) => revalidatedMethod(resp, prev));
    },
    onSettled: (_resp, _error, request) => {
      if (request.context === currentPreviewContext.current && request.sequence === voucherRequest.current) setVoucherBusyContext(null);
    },
  });

  function applyVoucher(): void {
    if (!selected || !totals || !configValid || submitLock.current) return;
    const sequence = ++voucherRequest.current;
    setVoucherBusyContext(previewContext);
    previewMutation.mutate({ code: voucherInput.trim().toUpperCase(), denominationId: selected.id, context: previewContext, sequence });
  }

  function onVoucherKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    applyVoucher();
  }

  // Mirrors CheckoutPage.tsx's placeOrderMutation (same guest-mode full-reload
  // vs. signed-in client nav, same order-code email handoff, identical response
  // shape) against this flow's own cart-free endpoint — customer_data is always
  // a single-unit array here, since InstantBuyPage never buys more than qty 1.
  //
  // `idempotentPost`, not `apiPost`: POST /api/v1/topup/order is the
  // order-creating call (routes/apiTopup.ts, TOPUP_ORDER_IDEMPOTENCY_ENDPOINT),
  // so a retry after a request that never came back must replay the first
  // attempt rather than buy twice. The preview and nickname-check calls above
  // create nothing and stay on the plain client.
  const idempotentPost = useIdempotentPost();
  const placeOrderMutation = useMutation({
    mutationFn: () =>
      idempotentPost<PlaceOrderResponse>("/api/v1/topup/order", {
        denomination_id: selected!.id,
        qty: 1,
        method,
        voucher_code: appliedVoucher,
        customer_data: needsInfo ? [JSON.parse(activeInputsJson) as Record<string, string>] : undefined,
        guest_email: page?.is_guest ? guestEmail.trim() : undefined,
      }),
    onSuccess: (resp) => {
      if (resp.email_sent === true) rememberCodeEmailed(resp.order_code, guestEmail.trim());
      if (resp.csrf_token || page?.is_guest) window.location.assign(resp.pay_url);
      else navigate(resp.pay_url);
    },
    onError: (err) => {
      setPlaceOrderError(err);
      if (page?.is_guest) void queryClient.invalidateQueries({ queryKey: ["context"] });
    },
    onSettled: () => { submitLock.current = false; },
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

  // A live preview still in flight means the totals on screen may not be the
  // ones the order would be charged at — same "don't submit against a price
  // we're not sure of" guard the old cart-sync pending flag provided.
  const readyToPay = Boolean(page && totals) && !previewQuery.isFetching && !voucherPending;
  const infoValid = !needsInfo || allFieldsValid(selected.additional_fields, [answers], 1);
  const guestEmailValid = !page?.is_guest || isValidEmail(guestEmail);
  const anyMethod = totals
    ? anyMethodEnabled(totals) || isIdrWalletSufficient(totals) || isUsdtWalletSufficient(totals)
    : false;
  // `previewErrorKey`: a failed re-price leaves the totals on screen unrelated
  // to (or stale against) the current selection — never let the buyer submit
  // against that. `!method`: I-3's flip side — a re-price can clear `method`
  // back to null (see the checkoutData effect above) without touching
  // `anyMethod`, so gate on the actual selection too, not just on whether
  // *some* method is offered.
  const submitBlocked =
    !readyToPay || !configValid || !purchasable(selected) || !infoValid || !guestEmailValid || !anyMethod || !method || previewErrorKey !== null;
  const submitDisabled = submitBlocked || placeOrderMutation.isPending;
  function submitOrder(): void {
    setCheckoutAttempted(true);
    if (submitBlocked || submitLock.current || placeOrderMutation.isPending) return;
    submitLock.current = true;
    placeOrderMutation.mutate();
  }
  const checkoutHint = !configValid ? t("error.input_config_invalid")
    : !purchasable(selected) ? t("web.checkout_product_unavailable")
    : previewErrorKey ? t("web.checkout_price_unavailable")
    : !readyToPay ? t("web.checkout_price_loading")
    : !infoValid ? t("web.checkout_account_hint")
    : !guestEmailValid ? t("web.checkout_contact_hint")
    : !anyMethod || !method ? t("web.checkout_payment_hint") : null;
  const purchasePrice = totals ? formatPriceFor(method === "qris" ? totals.qris_grand_total : totals.total, ctx?.currency ?? null, fx) : "";
  // Final-review fix: the sticky bar's "Price $X · Pay RpY" line for a USD
  // viewer on QRIS/PayDisini — same helper (and so the same rule and figures)
  // as the summary card; null everywhere else, which leaves the bar unchanged.
  const barPriceAndPay = totals ? idrRailPriceAndPay(method, totals, ctx?.currency ?? null, fx) : null;

  return (
    <>
      <Breadcrumb
        items={[
          { label: t("web.nav_home"), href: "/" },
          { label: product.category_name, href: `/c/${product.category_slug}` },
          { label: product.name },
        ]}
      />

      {previewErrorKey && (
        <Alert variant="banner" tone="error">
          {humanError(previewQuery.error)}
        </Alert>
      )}
      {placeOrderErrorKey && !(page?.is_guest && placeOrderErrorKey === "web.guest_email_invalid") && (
        <Alert variant="banner" tone="error">
          {humanError(placeOrderError)}
        </Alert>
      )}

      <form id="buy-form" noValidate onSubmit={(e) => { e.preventDefault(); submitOrder(); }} className="grid gap-6 items-start">
        <div className="space-y-6">
          {/* 1. Product header — image/title/description, ProductPage.tsx's
              own JSX pattern, folded into one card so it stacks with the rest
              of this page's sections. */}
          <div className="card card-pad">
            <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-sand">
              {product.image ? (
                <picture className="block w-full h-full">
                  {product.image_srcset && (
                    <source
                      type="image/webp"
                      srcSet={product.image_srcset}
                      sizes="(max-width: 768px) 100vw, 600px"
                    />
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
              ) : (
                <DefaultThumb kind={product.image_kind ?? "generic"} name={product.name} />
              )}
            </div>
            <h1 className="page-title mt-4">{product.name}</h1>
            {product.description && (
              <div className="mt-3 text-sm leading-relaxed text-ink-soft whitespace-pre-line">
                {product.description}
              </div>
            )}
          </div>

          {/* 2. Account field(s) — the selected denomination's own
              additional_fields, single-unit (no qty stepper, no per-unit
              loop, no "copy to all units": this page always buys qty 1). */}
          {!configValid && <Alert variant="banner" tone="error">{t("error.input_config_invalid")}</Alert>}
          {needsInfo && configValid && (
            <div className="card card-pad">
              <h2 className="section-title mb-1">{t("web.checkout_info_title")}</h2>
              <p className="text-xs text-ink-soft mb-3">{t("web.checkout_info_intro")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {selected.additional_fields.map((field) => (
                  <DeliveryFieldInput
                    key={`${selected.id}-${fieldConfigKey}-${field.key}`}
                    field={field}
                    inputId={`instant-${field.key}`}
                    value={answers[field.key] ?? ""}
                    onChange={(value) => setAnswers((prev) => ({ ...prev, [field.key]: value }))}
                    onBlur={() => setTouched((prev) => ({ ...prev, [field.key]: true }))}
                    showError={Boolean(touched[field.key] || checkoutAttempted)}
                  />
                ))}
              </div>
              {/* Task 7: live KokinPay nickname-check result — every
                  non-happy-path (no check configured, no credentials, a
                  network failure) renders nothing at all, so the field looks
                  and behaves exactly as it does today in those cases. */}
              {nicknameCheck.pending && (
                <p className="mt-2 text-xs text-ink-soft flex items-center gap-1.5" data-testid="nickname-check-pending">
                  <Spinner /> {t("web.nickname_checking")}
                </p>
              )}
              {!nicknameCheck.pending && nicknameCheck.nickname && (
                <p className="mt-2 text-xs text-grass-dark" data-testid="nickname-check-found">
                  {t("web.nickname_check_found", { nickname: nicknameCheck.nickname })}
                </p>
              )}
              {!nicknameCheck.pending && !nicknameCheck.nickname && nicknameCheck.notFound && (
                <p className="mt-2 text-xs text-ink-soft" data-testid="nickname-check-not-found">
                  {t("web.nickname_check_not_found")}
                </p>
              )}
            </div>
          )}

          {/* 3. Denomination grid — picking a plan re-prices via the
              preview query above (keyed on the selected id), so the
              totals/payment cards below always reflect exactly this one
              selection. No serialization guard is needed on rapid picks any
              more: a preview is a pure read, and React Query only surfaces the
              response for the currently-selected key, so nothing can be left
              half-applied the way the old read-cart/remove-lines/add-line
              sequence could. */}
          <div className="card card-pad">
            <h2 className="section-title mb-3">{t("web.choose_plan")}</h2>
            <div className="grid gap-3">
              {denominations.map((d) => (
                <DenominationCard
                  key={d.id}
                  d={d}
                  fx={fx}
                  lowThreshold={low_threshold}
                  checked={d.id === selected.id}
                  onChange={() => setSelectedId(d.id)}
                  iconKind={product.icon_kind}
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

        </div>

        {/* 5. Payment method — before the coupon and summary, using live
            totals so voucher discounts update wallet eligibility. */}
        <div>
          {page && totals ? (
            <PaymentMethodSelector data={totals} method={method} onSelect={setMethod} />
          ) : (
            <div className="card card-pad space-y-3" aria-busy="true" aria-label={t("web.loading")}>
              <Skeleton className="h-5 w-40" />
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          )}
        </div>

        {/* 6. Discount, summary and primary submit remain in document flow.
            Mobile also offers the same submit while the primary is offscreen. */}
        <div className="min-w-0">
          {page && totals ? (
            <OrderSummaryCard
              totals={totals}
              method={method}
              fx={fx}
              voucherInput={voucherInput}
              onVoucherInputChange={setVoucherInput}
              onVoucherApply={applyVoucher}
              onVoucherKeyDown={onVoucherKeyDown}
              voucherPending={voucherPending || placeOrderMutation.isPending}
              showDesktopSubmit
              submitRef={setPrimaryElement}
              submitId="instant-buy-submit"
              submitPrice={purchasePrice}
              accountSummary={{
                plan: selected.canonical?.displayName || selected.duration_label || selected.name,
                fields: selected.additional_fields.map((field) => ({ key: field.key, label: currentLang() === "id" ? field.label.id : field.label.en, value: (answers[field.key] ?? "").trim() })).filter((field) => field.value !== ""),
              }}
              submitLabel={t("web.buy_now")}
              submitIcon={<Zap className="w-4 h-4" />}
              submitDisabled={submitDisabled}
              submitBlocked={submitBlocked}
              onSubmit={submitOrder}
              submitPending={placeOrderMutation.isPending}
            />
          ) : (
            <>
              <div className="card card-pad space-y-3" aria-busy={!previewErrorKey && configValid} aria-label={t("web.loading")}>
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
              <Button ref={setPrimaryElement} id="instant-buy-submit" variant="primary" fullWidth className="mt-4" disabled onClick={submitOrder}>{t("web.buy_now")}</Button>
            </>
          )}
        </div>
        {configValid && checkoutHint && <p className="text-sm text-ink-soft" role="status">{checkoutHint}</p>}
        {previewMutation.error && !voucherPending && previewMutation.variables?.context === previewContext && <Alert variant="banner" tone="error">{humanError(previewMutation.error)}</Alert>}
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

      {/* Sticky mobile total + submit — the shared <StickyPurchaseBar>
          (components.md "Sticky purchase bar"), reusing the same
          placeOrderMutation and the same submitDisabled/submitBlocked gating
          as the primary submit button in OrderSummaryCard above: one purchase
          path. `submitBlocked` mutes the button ("can't proceed yet"),
          `submitDisabled` (blocked OR pending) actually disables it. */}
      {!isDesktop && !primaryVisible && page && totals && (
        <StickyPurchaseBar
          reserveFooterSpace
          ariaLabel={t("web.purchase_bar")}
          priceLabel={t("web.order_total")}
          price={purchasePrice}
          secondaryChip={barPriceAndPay && <span className="text-xs text-ink-soft">{barPriceAndPay}</span>}
          primaryAction={{
            label: placeOrderMutation.isPending ? t("web.checkout_processing") : t("web.buy_now"),
            onClick: submitOrder,
            pending: placeOrderMutation.isPending,
            disabled: submitDisabled,
            blocked: submitBlocked,
          }}
        />
      )}
    </>
  );
}
