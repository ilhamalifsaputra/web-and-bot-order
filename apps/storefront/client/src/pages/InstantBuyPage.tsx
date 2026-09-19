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
import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Package, ScrollText, ShieldCheck, Zap } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import { useIdempotentPost } from "../api/idempotency";
import type { CheckoutData, PlaceOrderResponse, ProductPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { t } from "../lib/i18n";
import { humanError } from "../lib/errors";
import { formatIdr } from "../lib/format";
import { fadeUp } from "../lib/motion";
import { rememberCodeEmailed } from "../lib/orderCodeEmailed";
import { allFieldsValid, isValidEmail } from "../lib/deliveryFields";
import { useIsDesktop } from "../lib/useMediaQuery";
import Breadcrumb from "../components/shop/Breadcrumb";
import Callout from "../components/shop/Callout";
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
import OrderSummaryCard from "../components/shop/OrderSummaryCard";
import { GuestContactCard } from "./CheckoutPage";
import ErrorPage from "./ErrorPage";

// Code review: the minimum length below a live nickname-check lookup is
// pointless to fire — too short to be any real game account id, so the only
// effect of checking it would be an extra KokinPay call and a flash of a
// misleading "not found" hint while the buyer is still typing.
const MIN_ACCOUNT_ID_LENGTH = 4;

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
  // The rejection itself, not just its key — the figures its copy quotes ride on
  // the Error (`errorArgs`, F4a). The derived key below is what the two
  // guest-email branches compare against.
  const [placeOrderError, setPlaceOrderError] = useState<unknown>(null);
  const placeOrderErrorKey = placeOrderError instanceof Error ? placeOrderError.message : null;
  const [page, setPage] = useState<CheckoutData | null>(null);
  const [totals, setTotals] = useState<CheckoutData | null>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [slug]);

  const denominations = data?.denominations ?? [];
  const fallback = denominations.find((d) => d.in_stock) ?? denominations[0];
  const selected = denominations.find((d) => d.id === selectedId) ?? fallback;
  const needsInfo = selected?.delivery_type === "manual_with_info" && selected.additional_fields.length > 0;

  // Live totals for the SELECTED denomination — an ad-hoc line priced by the
  // server, with no cart anywhere in the loop. Keyed on the denomination id, so
  // picking a different plan re-prices automatically (this replaces the
  // cart-sync effect the old design fired off the same trigger), and React
  // Query only ever surfaces the response belonging to the current key — a
  // slow answer for an abandoned selection can't overwrite a newer one.
  const previewQuery = useQuery({
    queryKey: ["topup-preview", selected?.id],
    queryFn: () =>
      apiPost<CheckoutData>("/api/v1/topup/preview", { denomination_id: selected!.id, qty: 1 }),
    enabled: selected != null,
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
  }, [checkoutData]);

  // A different denomination has a different (possibly empty) field set —
  // stale answers from the last selection would otherwise ride along into a
  // customer_data payload that no longer matches the fields being shown.
  useEffect(() => {
    setAnswers({});
  }, [selected?.id]);

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
  // Region-check Task C: `regionMismatch` rides the exact same debounced
  // request/response lifecycle as `nickname`/`notFound` above — it's read off
  // the SAME check-account response (one HTTP call, not two), never its own
  // effect/timer. Reset alongside the rest of `nicknameCheck` on every
  // account-field change / denomination switch, same "stale signal next to a
  // since-edited id" reasoning as the nickname fields.
  const [nicknameCheck, setNicknameCheck] = useState<{
    pending: boolean;
    nickname: string | null;
    notFound: boolean;
    regionMismatch: boolean;
  }>({ pending: false, nickname: null, notFound: false, regionMismatch: false });

  const accountId = (answers.user_id ?? "").trim();
  const accountServer = (answers.server_id ?? "").trim();

  useEffect(() => {
    // Any change to the account field(s) (including a denomination switch,
    // which resets `answers` above) invalidates whatever the last check
    // showed — clear immediately rather than let a stale nickname linger
    // next to a since-edited id.
    setNicknameCheck({ pending: false, nickname: null, notFound: false, regionMismatch: false });
    if (!needsInfo || !selected) return;
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
    if (accountId.length < MIN_ACCOUNT_ID_LENGTH) return;
    const requiresServer = selected.additional_fields.some((field) => field.key === "server_id");
    if (requiresServer && !accountServer) return;

    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => {
      setNicknameCheck((prev) => ({ ...prev, pending: true }));
      apiPost<{ available: boolean; valid?: boolean; nickname?: string | null; region_mismatch?: boolean }>(
        "/api/v1/topup/check-account",
        { denomination_id: selected.id, id: accountId, server: accountServer || undefined },
        { signal: controller.signal },
      )
        .then((res) => {
          if (cancelled) return;
          // Region-check Task C: `region_mismatch` is read off this SAME
          // response regardless of the nickname-check outcome below — the two
          // signals are independent on the backend, so the UI reads them
          // independently too, not nested inside the nickname branches.
          const regionMismatch = res.region_mismatch === true;
          if (res.available && res.valid && res.nickname) {
            setNicknameCheck({ pending: false, nickname: res.nickname, notFound: false, regionMismatch });
          } else if (res.available && res.valid === false) {
            setNicknameCheck({ pending: false, nickname: null, notFound: true, regionMismatch });
          } else {
            // available: false — no check configured, no credentials, or a
            // network/HTTP failure. Never surfaced: the field looks and
            // behaves exactly as it does today (region_mismatch can still be
            // true here — the two providers are independent).
            setNicknameCheck({ pending: false, nickname: null, notFound: false, regionMismatch });
          }
        })
        .catch(() => {
          // A cancelled (AbortError) or otherwise failed request — same
          // silent no-op, never an error state shown to the buyer.
          if (cancelled) return;
          setNicknameCheck({ pending: false, nickname: null, notFound: false, regionMismatch: false });
        });
    }, 800);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [needsInfo, selected?.id, accountId, accountServer]);

  // Applying a voucher re-prices the SAME ad-hoc line the query above prices,
  // through the SAME endpoint — one pricing implementation, so a voucher can
  // never be quoted against something other than the plan on screen.
  const previewMutation = useMutation({
    mutationFn: (voucherCode: string) =>
      apiPost<CheckoutData>("/api/v1/topup/preview", {
        denomination_id: selected!.id,
        qty: 1,
        voucher_code: voucherCode,
      }),
    onSuccess: (resp) => {
      setTotals(resp);
      // I-3, widened: a voucher application re-prices `totals` directly
      // (never touching `checkoutData`, which is what the effect above
      // keys on), so that effect alone can't catch a re-price triggered
      // this way — e.g. swapping in a smaller-discount code after
      // wallet_idr was already selected for a larger-discount total. Same
      // check, same clear, just fired from this trigger too.
      setMethod((prev) => revalidatedMethod(resp, prev));
    },
  });

  function applyVoucher(): void {
    previewMutation.mutate(voucherInput);
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
      setPlaceOrderError(err);
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

  // A live preview still in flight means the totals on screen may not be the
  // ones the order would be charged at — same "don't submit against a price
  // we're not sure of" guard the old cart-sync pending flag provided.
  const readyToPay = Boolean(page && totals) && !previewQuery.isFetching;
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
    !readyToPay || !purchasable(selected) || !infoValid || !guestEmailValid || !anyMethod || !method || previewErrorKey !== null;
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

      <form onSubmit={(e) => e.preventDefault()} className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
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
          {needsInfo && (
            <div className="card card-pad">
              <h2 className="section-title mb-1">{t("web.checkout_info_title")}</h2>
              <p className="text-xs text-ink-soft mb-3">{t("web.checkout_info_intro")}</p>
              {/* Region-check Task C: admin-authored precautionary copy — shown
                  whenever set, regardless of the live checks below, so the
                  buyer reads it before typing. */}
              {selected.region_warning && (
                <div className="mb-3">
                  <Callout variant="info">{selected.region_warning}</Callout>
                </div>
              )}
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
              {/* Region-check Task C: automatic mismatch hint — only when the
                  check-account response signalled region_mismatch: true. Never
                  disables/hides the submit button (see submitBlocked below,
                  which never references nicknameCheck at all) — a dismissible
                  hint, not a blocker. */}
              {!nicknameCheck.pending && nicknameCheck.regionMismatch && (
                <div className="mt-2" data-testid="region-mismatch-hint">
                  <Callout variant="warning">{t("web.region_mismatch_hint")}</Callout>
                </div>
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

        {/* 5. Payment method — full-width row below both columns (Task 5):
            with grid-cols-3 and the left column (col-span-2) plus
            OrderSummaryCard (1 implicit column) already filling row 1, a
            col-span-3 item can't fit there and auto-placement wraps it to
            its own full-width row 2. Must stay in DOM order AFTER
            OrderSummaryCard — placed before it would instead push
            OrderSummaryCard itself down to row 2. `totals`, not `page` —
            see CheckoutPage.tsx's matching call site for why: `page`
            doesn't track a voucher preview response, and wallet-credit
            sufficiency has to be gated on the live, post-voucher total. */}
        <div className="lg:col-span-3">
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

      {/* Sticky mobile total + submit — the shared <StickyPurchaseBar>
          (components.md "Sticky purchase bar"), reusing the same
          placeOrderMutation and the same submitDisabled/submitBlocked gating
          as the desktop submit button in OrderSummaryCard above: one purchase
          path. `submitBlocked` mutes the button ("can't proceed yet"),
          `submitDisabled` (blocked OR pending) actually disables it. */}
      {!isDesktop && page && totals && (
        <StickyPurchaseBar
          ariaLabel={t("web.purchase_bar")}
          priceLabel={t("web.order_total")}
          price={formatIdr(method === "qris" ? totals.qris_grand_total : totals.total)}
          primaryAction={{
            label: t("web.buy_now"),
            onClick: () => placeOrderMutation.mutate(),
            pending: placeOrderMutation.isPending,
            disabled: submitDisabled,
            blocked: submitBlocked,
          }}
        />
      )}
    </>
  );
}
