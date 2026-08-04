/**
 * TSX port of apps/storefront/views/checkout.njk + its embedded totals
 * partial views/_checkout_totals.njk. checkout.njk's inline <script>
 * intercepts Enter on #voucher_code so it previews the voucher instead of
 * submitting the real order (see the onKeyDown handler below) — ported as a
 * plain event handler since none of our buttons are type="submit" anyway.
 *
 * State is split the same way the HTMX swap split the page: `page` (payment
 * method radios) is set ONCE from the initial GET and never touched again —
 * the voucher-preview response only ever swapped #checkout-summary in the
 * NJK, never the method radios. `totals` mirrors that #checkout-summary
 * fragment: initialized from the same GET, then replaced wholesale by every
 * voucher-preview response (subtotal/discounts/total + the method-enabled
 * flags _checkout_totals.njk uses to gate the Place Order button). The
 * voucher input itself is a THIRD, independent piece of state — its live
 * typed value is what Place Order submits, whether or not Apply/Enter was
 * ever pressed, exactly like the NJK's hx-include="closest form" left the
 * input's value untouched by the swap.
 *
 * Wallet credit ("Wallet Credit (IDR)"/"Wallet Credit (USDT)") is just two
 * more entries in the same method radio group — all-or-nothing, only
 * rendered when that currency's balance covers the live (post-voucher)
 * total. Selecting one and hitting "Place order & pay" posts
 * method: "wallet_idr"/"wallet_usdt" to the same /api/v1/checkout endpoint
 * gateway methods use; the server (routes/api.ts) branches to the no-gateway
 * performWalletCheckout path before ever looking at a voucher/customer_data.
 *
 * Markup/classes copied verbatim apart from the mechanical Tailwind v3→v4
 * renames (docs/REACT_STOREFRONT_MIGRATION.md), with two deliberate mobile
 * departures from template parity documented at PaymentMethodRow (selected
 * state) and at the sticky total bar near the bottom of this file.
 */
import { useEffect, useState, type ReactNode, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, ShoppingCart, Wallet } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { AdditionalField, CheckoutData, PlaceOrderResponse } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatIdr, formatNativeUsdt } from "../lib/format";
import { allFieldsValid, isValidEmail } from "../lib/deliveryFields";
import { useIsDesktop } from "../lib/useMediaQuery";
import EmptyState from "../components/shop/EmptyState";
import FlashBadge, { flashPercentLabel } from "../components/shop/FlashBadge";
import Price from "../components/shop/Price";
import Skeleton from "../components/shop/Skeleton";
import Stepper from "../components/shop/Stepper";
import DeliveryFieldInput from "../components/shop/DeliveryFieldInput";
import Spinner from "../components/shop/Spinner";

/** All-or-nothing wallet-credit gates: only "sufficient" when the balance
 * covers the live total outright — never offered as a partial discount.
 * `wallet_*_enabled` comes first because it answers a different question: may
 * this shop offer a balance payment to THIS visitor at all (it is false for a
 * guest, who has no wallet behind the number). Reading the server's flag
 * rather than `is_guest` keeps that decision on the server side. */
function isIdrWalletSufficient(data: CheckoutData): boolean {
  return data.wallet_idr_enabled && Number(data.total) > 0 && Number(data.wallet_idr) >= Number(data.total);
}
function isUsdtWalletSufficient(data: CheckoutData): boolean {
  return (
    data.wallet_usdt_enabled && data.total_usdt != null && Number(data.wallet_usdt) >= Number(data.total_usdt)
  );
}

/** checkout.njk's default-selection cascade: the first enabled method wins,
 * in file/priority order (qris → paydisini → binance → bybit → bybit_bsc →
 * nowpayments), falling back to wallet credit only when no gateway is
 * configured at all — a buyer with both a gateway and wallet credit
 * available shouldn't have their credit silently pre-selected for them.
 * Returns null when nothing is payable. */
function defaultMethod(data: CheckoutData): string | null {
  if (data.idr_enabled) return "qris";
  if (data.paydisini_enabled) return "paydisini";
  if (data.binance_enabled) return "binance";
  if (data.bybit_enabled) return "bybit";
  if (data.bybit_bsc_enabled) return "bybit_bsc";
  if (data.nowpayments_enabled) return "nowpayments";
  if (isIdrWalletSufficient(data)) return "wallet_idr";
  if (isUsdtWalletSufficient(data)) return "wallet_usdt";
  return null;
}

/**
 * The biggest live flash discount in the cart, plus the last moment any of
 * them is still running — the summary's one modest "this is a sale price"
 * marker. Read from the checkout payload's own `items`, which are priced and
 * flagged against the same instant as the totals beside them, so the marker
 * can never disagree with the figures it annotates.
 */
function cartFlashSummary(data: CheckoutData | undefined): { percent: number; endsAt: string | null } | null {
  let percent: number | null = null;
  let endsAt: string | null = null;
  for (const line of data?.items ?? []) {
    const pct = flashPercentLabel(line.flash?.discount_percent);
    if (pct === null) continue;
    if (percent === null || pct > percent) percent = pct;
    const lineEnd = line.flash?.ends_at ?? null;
    if (lineEnd && (endsAt === null || lineEnd > endsAt)) endsAt = lineEnd;
  }
  return percent === null ? null : { percent, endsAt };
}

/**
 * Turn whatever an API rejection carried into something a shopper can read.
 *
 * The server's own failures arrive as i18n keys ("error.rate_limited",
 * "web.guest_email_invalid"), which `t()` renders. Anything else is the API
 * client's developer-facing fallback ("/api/v1/checkout responded 500") or a
 * network error, and `t()` would hand that string straight back — so those
 * become the generic apology instead. Guest checkout widened the set of
 * failures this page can hit (throttles on an anonymous read, a session
 * minted mid-request), which is what makes the distinction worth making.
 */
function humanError(message: string): string {
  return message.startsWith("web.") || message.startsWith("error.") ? t(message) : t("web.error_message");
}

function anyMethodEnabled(data: CheckoutData): boolean {
  return (
    data.idr_enabled ||
    data.paydisini_enabled ||
    data.binance_enabled ||
    data.bybit_enabled ||
    data.bybit_bsc_enabled ||
    data.nowpayments_enabled
  );
}

/**
 * One payment-method radio row (gateway or wallet credit — they are the same
 * radio group). The row has always been a `<label>` wrapping its radio, so the
 * whole rectangle was already tappable; what it lacked was a selected state a
 * thumb-held phone can read. The native radio dot sits at the row's left edge,
 * exactly where the hand covering the screen is, so the buyer could not tell
 * which rail was armed without moving their hand. `has-[:checked]:` tints and
 * outlines the entire row instead, and `focus-within` gives the same row a
 * visible ring when the group is walked with the arrow keys. checkout.njk had
 * neither (that pattern only existed on product.njk's DenominationCard) — a
 * deliberate departure from template parity, not a porting oversight.
 *
 * Extracted from eight near-identical inline labels so the row treatment lives
 * in one place; which rows render, and under what conditions, stays at the
 * call sites untouched.
 */
function PaymentMethodRow({
  value,
  checked,
  onSelect,
  icon,
  title,
  subtitle,
  feeNote,
}: {
  value: string;
  checked: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  subtitle: string;
  feeNote?: string;
}) {
  return (
    <label className="flex items-start gap-3 p-3 rounded-xl border border-line transition-colors cursor-pointer hover:border-pine focus-within:ring-2 focus-within:ring-pine has-[:checked]:border-pine has-[:checked]:bg-pine-tint">
      <input
        type="radio"
        name="method"
        value={value}
        className="mt-1 size-4 shrink-0 accent-pine"
        checked={checked}
        onChange={onSelect}
      />
      {icon}
      {/* min-w-0 lets a long gateway description wrap rather than push the row
          wider than a 320px viewport. */}
      <span className="min-w-0">
        <span className="font-semibold text-sm block">{title}</span>
        <span className="text-xs text-ink-soft block mt-0.5">{subtitle}</span>
        {feeNote && <span className="text-xs text-ink-faint block mt-0.5">{feeNote}</span>}
      </span>
    </label>
  );
}

/**
 * Info-collection step (Task 6, item 1): for the ONE manual_with_info line a
 * cart may hold (single-SKU-per-non-auto-cart guard, routes/api.ts POST
 * /cart), collects `additional_fields` answers once per unit (qty times) —
 * inline form sections, not a multi-step wizard (this is a web page, unlike
 * the bot's chat-turn "Unit N of M" wizard it conceptually mirrors). Renders
 * ABOVE the payment card, gating "Place Order" until every unit validates.
 * Client-side validation (lib/deliveryFields.ts) is a UX convenience only —
 * the server re-validates from scratch before persisting (routes/checkout.ts
 * performCheckout).
 */
function InfoStepCard({
  fields,
  qty,
  answers,
  onChange,
}: {
  fields: AdditionalField[];
  qty: number;
  answers: Array<Record<string, string>>;
  onChange: (unitIdx: number, key: string, value: string) => void;
}) {
  // STO-010: buying multiple units of the same manual_with_info product for
  // yourself is common — copy Unit 1's answers into every other unit rather
  // than making the buyer retype the same email N times.
  function copyToAll(): void {
    const first = answers[0] ?? {};
    for (let unitIdx = 1; unitIdx < qty; unitIdx++) {
      for (const field of fields) {
        onChange(unitIdx, field.key, first[field.key] ?? "");
      }
    }
  }

  return (
    <div className="card card-pad">
      <h2 className="section-title mb-1">{t("web.checkout_info_title")}</h2>
      <p className="text-xs text-ink-soft mb-3">{t("web.checkout_info_intro")}</p>
      <div className="space-y-5">
        {Array.from({ length: qty }, (_, unitIdx) => (
          <div key={unitIdx} className={qty > 1 ? "border border-line rounded-xl p-3" : ""}>
            {qty > 1 && (
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-xs font-semibold text-ink-soft">
                  {t("web.checkout_info_unit", { unit: unitIdx + 1, total: qty })}
                </div>
                {unitIdx === 0 && (
                  <button
                    type="button"
                    className="text-xs font-medium text-pine transition-colors hover:text-pine-dark underline shrink-0"
                    onClick={copyToAll}
                  >
                    {t("web.checkout_info_copy_all")}
                  </button>
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((field) => (
                <DeliveryFieldInput
                  key={field.key}
                  field={field}
                  inputId={`info-${unitIdx}-${field.key}`}
                  value={answers[unitIdx]?.[field.key] ?? ""}
                  onChange={(value) => onChange(unitIdx, field.key, value)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Guest checkout's one extra question. Deliberately not a gate: the sign-in
 * link is an offer sitting beside the field, not a door in front of it, and
 * the hint says what the address is FOR rather than just demanding it.
 */
function GuestContactCard({
  email,
  onChange,
  invalid,
}: {
  email: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="card card-pad">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="section-title">{t("web.guest_contact_title")}</h2>
        <Link
          to="/login?next=/checkout"
          className="text-sm font-medium text-pine underline transition-colors hover:text-pine-dark"
        >
          {t("web.guest_have_account")}
        </Link>
      </div>
      <label className="field-label" htmlFor="guest_email">
        {t("web.guest_email_label")}
      </label>
      <input
        id="guest_email"
        type="email"
        className="field"
        value={email}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="email"
        inputMode="email"
        placeholder="you@example.com"
        aria-describedby="guest_email_hint"
        aria-invalid={invalid ? true : undefined}
        required
      />
      <p id="guest_email_hint" className="mt-2 text-xs leading-relaxed text-ink-soft">
        {t("web.guest_email_hint")}
      </p>
    </div>
  );
}

export default function CheckoutPage() {
  const navigate = useNavigate();
  const { data: ctx } = useShopContext();
  // Decides which of the two submit controls exists — see the sticky bar below.
  const isDesktop = useIsDesktop();
  const { data, error } = useQuery({
    queryKey: ["checkout"],
    queryFn: () => apiGet<CheckoutData>("/api/v1/checkout"),
    retry: false,
  });

  const [page, setPage] = useState<CheckoutData | null>(null);
  const [totals, setTotals] = useState<CheckoutData | null>(null);
  const [voucherInput, setVoucherInput] = useState("");
  const [method, setMethod] = useState<string | null>(null);
  const [placeOrderErrorKey, setPlaceOrderErrorKey] = useState<string | null>(null);
  // Guest checkout only — a registered buyer never sees the field, and the
  // value is never sent for them (the server ignores it anyway).
  const [guestEmail, setGuestEmail] = useState("");
  // One answer-map per unit for the manual_with_info info step — [] when the
  // cart has no such line (the section then renders nothing).
  const [answers, setAnswers] = useState<Array<Record<string, string>>>([]);

  // No 401 redirect to /login any more: GET /api/v1/checkout serves anonymous
  // visitors (guest checkout), so being signed out is a normal state of this
  // page rather than an error to bounce out of. Any failure that DOES happen
  // (a 429 from the anonymous read throttle, a network blip) is rendered
  // below instead of leaving the visitor on a blank page.

  // First load only: seed both halves of the split state, the voucher input,
  // and the default method selection. Never re-runs once `page` is set —
  // later GETs of this query (e.g. a background refetch) must not clobber
  // whatever the buyer has since typed/selected.
  useEffect(() => {
    if (data && !page) {
      setPage(data);
      setTotals(data);
      setVoucherInput(data.voucher_code ?? "");
      setMethod(defaultMethod(data));
      const infoItem = data.items.find((i) => i.delivery_type === "manual_with_info");
      if (infoItem) setAnswers(Array.from({ length: infoItem.qty }, () => ({})));
    }
  }, [data, page]);

  const previewMutation = useMutation({
    mutationFn: (voucherCode: string) =>
      apiPost<CheckoutData>("/api/v1/checkout/voucher/preview", { voucher_code: voucherCode }),
    onSuccess: (resp) => setTotals(resp),
  });

  function applyVoucher(): void {
    previewMutation.mutate(voucherInput);
  }

  function onVoucherKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Mirrors checkout.njk's inline script exactly: ignore Enter presses that
    // are really an IME composing an East-Asian character, not a real submit.
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    applyVoucher();
  }

  // Drives both gateway methods and wallet credit ("wallet_idr"/"wallet_usdt"
  // — just two more radio values) — the server branches on `method` before
  // ever looking at voucher_code/customer_data for the wallet case.
  const placeOrderMutation = useMutation({
    mutationFn: () =>
      apiPost<PlaceOrderResponse>("/api/v1/checkout", {
        method,
        voucher_code: voucherInput,
        customer_data: page?.items.some((i) => i.delivery_type === "manual_with_info") ? answers : undefined,
        // Sent only in guest mode. The server treats it as the guest account's
        // contact address and ignores it entirely for a signed-in buyer.
        guest_email: page?.is_guest ? guestEmail.trim() : undefined,
      }),
    onSuccess: (resp) => {
      // A `csrf_token` in the response means this request MINTED a session
      // (guest checkout). The whole shell has to be re-rendered for the app to
      // see it — account menu, cart ownership, the CSRF meta tag — so leave
      // the SPA the way LoginPage does rather than route client-side. A
      // signed-in buyer gets no token and keeps the instant client-side
      // navigation they have today.
      if (resp.csrf_token) window.location.assign(resp.pay_url);
      else navigate(resp.pay_url);
    },
    onError: (err) => setPlaceOrderErrorKey((err as Error).message),
  });

  // Nothing loaded yet, and nothing went wrong: a placeholder shaped like the
  // page, not the blank screen this used to render while the query was in
  // flight (STO-006 / performance.md, same treatment as OrdersPage).
  if (!page || !totals) {
    if (!error) {
      return (
        <div aria-busy="true" aria-label={t("web.loading")}>
          <Skeleton className="mb-5 h-8 w-48" />
          <div className="grid items-start gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <div className="card card-pad space-y-3">
                <Skeleton className="h-5 w-40" />
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-xl" />
                ))}
              </div>
              <div className="card card-pad space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
            <div className="card card-pad space-y-3">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        </div>
      );
    }
    // The checkout payload never arrived — most likely the anonymous read
    // throttle (429). Say so in words the buyer can act on and give them
    // somewhere to go, rather than leaving an empty page or a bare error key.
    return (
      <>
        <Stepper step={2} />
        <h1 className="page-title text-2xl! mb-5">{t("web.checkout_title")}</h1>
        <EmptyState
          icon={AlertTriangle}
          title={t("web.checkout_unavailable")}
          description={humanError((error as Error).message)}
          action={{ label: t("web.back_to_cart"), to: "/cart" }}
          secondaryAction={{ label: t("web.nav_products"), to: "/products" }}
        />
      </>
    );
  }

  // An empty cart used to bounce to /cart. For a guest that is one navigation
  // to an equally empty screen — say it here, where they are, and name the way
  // forward. Never render a payment form for a cart with nothing in it.
  if (page.items_empty) {
    return (
      <>
        <Stepper step={2} />
        <h1 className="page-title text-2xl! mb-5">{t("web.checkout_title")}</h1>
        <EmptyState
          icon={ShoppingCart}
          title={t("web.checkout_empty_title")}
          description={t("web.cart_empty_desc")}
          action={{ label: t("web.nav_products"), to: "/products" }}
          secondaryAction={{ label: t("web.back_to_cart"), to: "/cart" }}
        />
      </>
    );
  }

  // Wallet-credit radios — only offered when credit fully covers the live
  // total (post-voucher); hidden (not disabled) otherwise.
  const idrWalletSufficient = isIdrWalletSufficient(totals);
  const usdtWalletSufficient = isUsdtWalletSufficient(totals);
  const anyMethod = anyMethodEnabled(totals) || idrWalletSufficient || usdtWalletSufficient;
  // Info step (Task 6): the single-SKU-per-non-auto-cart guard means there's
  // ever at most one manual_with_info line.
  const infoItem = page.items.find((i) => i.delivery_type === "manual_with_info") ?? null;
  const infoValid = !infoItem || allFieldsValid(infoItem.additional_fields, answers, infoItem.qty);
  // `page` holds the item list; `totals` is the re-priced payload after a
  // voucher apply. Either carries the same per-line flash flags.
  const flashSummary = cartFlashSummary(page);
  // Both submit controls share one set of gates so neither can offer an order
  // the other refuses: `blocked` is the permanent "not payable yet" state the
  // dimmed styling explains, `disabled` adds the transient in-flight state.
  // Client-side courtesy only — it saves a wasted round trip; the server
  // re-validates and owns `web.guest_email_invalid`.
  const guestEmailValid = !page.is_guest || isValidEmail(guestEmail);
  const placeOrderBlocked = !anyMethod || !infoValid || !guestEmailValid;
  const placeOrderDisabled = placeOrderBlocked || placeOrderMutation.isPending;

  function setAnswer(unitIdx: number, key: string, value: string): void {
    setAnswers((prev) => {
      const next = prev.slice();
      next[unitIdx] = { ...next[unitIdx], [key]: value };
      return next;
    });
  }

  return (
    <>
      <Stepper step={2} />
      <h1 className="page-title text-2xl! mb-5">{t("web.checkout_title")}</h1>

      {placeOrderErrorKey && (
        <div className="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mb-5">
          <AlertTriangle className="w-4 h-4" /> {humanError(placeOrderErrorKey)}
        </div>
      )}

      <form
        onSubmit={(e) => e.preventDefault()}
        className="grid lg:grid-cols-3 gap-6 items-start"
        // The sticky bar is fixed, so it is out of flow and would otherwise sit
        // on top of the last thing in the form ("Back to cart"). Reserve its
        // height plus the home-indicator inset at the end of the page instead.
        style={isDesktop ? undefined : { paddingBottom: "calc(env(safe-area-inset-bottom) + 5.5rem)" }}
      >
        <div className="lg:col-span-2 space-y-6">
          {/* First card in the column for a guest: the shop needs to know
              where the order goes before anything about paying for it. */}
          {page.is_guest && (
            <GuestContactCard
              email={guestEmail}
              onChange={setGuestEmail}
              invalid={placeOrderErrorKey === "web.guest_email_invalid"}
            />
          )}

          {infoItem && (
            <InfoStepCard fields={infoItem.additional_fields} qty={infoItem.qty} answers={answers} onChange={setAnswer} />
          )}

          <div className="card card-pad">
            <h2 className="section-title mb-3">{t("web.pay_method")}</h2>
            <div className="space-y-3">
              {page.idr_enabled && (
                <PaymentMethodRow
                  value="qris"
                  checked={method === "qris"}
                  onSelect={() => setMethod("qris")}
                  icon={
                    <img
                      src="/static/pay/qris.png"
                      alt="QRIS"
                      className="h-7 w-auto max-w-[80px] object-contain shrink-0 mt-0.5"
                    />
                  }
                  title={t("web.pay_idr_title")}
                  subtitle={t("web.pay_idr_sub")}
                  feeNote={t("web.qris_admin_fee_note")}
                />
              )}
              {page.paydisini_enabled && (
                <PaymentMethodRow
                  value="paydisini"
                  checked={method === "paydisini"}
                  onSelect={() => setMethod("paydisini")}
                  icon={
                    <img
                      src="/static/pay/qris.png"
                      alt="PayDisini"
                      className="h-7 w-auto max-w-[80px] object-contain shrink-0 mt-0.5"
                    />
                  }
                  title={t("web.pay_paydisini_title")}
                  subtitle={t("web.pay_paydisini_sub")}
                />
              )}
              {page.binance_enabled && (
                <PaymentMethodRow
                  value="binance"
                  checked={method === "binance"}
                  onSelect={() => setMethod("binance")}
                  icon={
                    <img
                      src="/static/pay/binance.png"
                      alt="Binance"
                      className="h-7 w-7 object-contain shrink-0 mt-0.5"
                    />
                  }
                  title={t("web.pay_usdt_title")}
                  subtitle={t("web.pay_usdt_sub")}
                />
              )}
              {page.bybit_enabled && (
                <PaymentMethodRow
                  value="bybit"
                  checked={method === "bybit"}
                  onSelect={() => setMethod("bybit")}
                  icon={
                    <img
                      src="/static/pay/bybit.png"
                      alt="Bybit"
                      className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
                    />
                  }
                  title={t("web.pay_bybit_title")}
                  subtitle={t("web.pay_bybit_sub")}
                />
              )}
              {page.bybit_bsc_enabled && (
                <PaymentMethodRow
                  value="bybit_bsc"
                  checked={method === "bybit_bsc"}
                  onSelect={() => setMethod("bybit_bsc")}
                  icon={
                    <img
                      src="/static/pay/bybit.png"
                      alt="Bybit"
                      className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
                    />
                  }
                  title={t("web.pay_bybit_bsc_title")}
                  subtitle={t("web.pay_bybit_bsc_sub")}
                />
              )}
              {page.nowpayments_enabled && (
                <PaymentMethodRow
                  value="nowpayments"
                  checked={method === "nowpayments"}
                  onSelect={() => setMethod("nowpayments")}
                  icon={
                    <img
                      src="/static/pay/nowpayments.png"
                      alt="NOWPayments"
                      className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
                    />
                  }
                  title={t("web.pay_nowpayments_title")}
                  subtitle={t("web.pay_nowpayments_sub")}
                />
              )}
              {idrWalletSufficient && (
                <PaymentMethodRow
                  value="wallet_idr"
                  checked={method === "wallet_idr"}
                  onSelect={() => setMethod("wallet_idr")}
                  icon={<Wallet className="h-7 w-7 object-contain shrink-0 mt-0.5 text-pine" />}
                  title={t("web.pay_wallet_idr_title")}
                  subtitle={t("web.pay_wallet_idr_sub", { amount: formatIdr(page.wallet_idr) })}
                />
              )}
              {usdtWalletSufficient && (
                <PaymentMethodRow
                  value="wallet_usdt"
                  checked={method === "wallet_usdt"}
                  onSelect={() => setMethod("wallet_usdt")}
                  icon={<Wallet className="h-7 w-7 object-contain shrink-0 mt-0.5 text-pine" />}
                  title={t("web.pay_wallet_usdt_title")}
                  subtitle={t("web.pay_wallet_usdt_sub", { amount: formatNativeUsdt(page.wallet_usdt) })}
                />
              )}
              {!anyMethodEnabled(page) && !idrWalletSufficient && !usdtWalletSufficient && (
                <div className="text-center text-sm text-ink-soft border border-dashed border-line rounded-xl py-6 px-3">
                  <Wallet className="w-5 h-5 mx-auto mb-1.5 text-ink-faint" />
                  <p>
                    {t("web.pay_none_available_prefix")}{" "}
                    <Link to="/account/support" className="text-pine underline transition-colors hover:text-pine-dark">
                      {t("web.pay_none_available_link")}
                    </Link>
                    {t("web.pay_none_available_suffix")}
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="card card-pad">
            <label className="field-label" htmlFor="voucher_code">
              {t("web.voucher_label")}
            </label>
            <div className="flex gap-2">
              <input
                id="voucher_code"
                value={voucherInput}
                onChange={(e) => setVoucherInput(e.target.value)}
                onKeyDown={onVoucherKeyDown}
                className="field uppercase"
                placeholder={t("web.voucher_placeholder")}
                maxLength={32}
                aria-invalid={totals.error_key ? true : undefined}
                aria-describedby={totals.error_key ? "voucher_code_error" : undefined}
              />
              <button
                type="button"
                id="voucher_apply"
                className="btn btn-soft shrink-0"
                disabled={previewMutation.isPending}
                onClick={applyVoucher}
              >
                {previewMutation.isPending && <Spinner />}
                {t("web.voucher_apply")}
              </button>
            </div>
            {/* STO-005: the voucher error belongs next to the field it
                validates, on every viewport — it used to render in the
                summary column, a full column gutter away on desktop. */}
            {totals.error_key && (
              <p id="voucher_code_error" role="alert" className="mt-2 text-sm text-rust-dark flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0" /> {t(totals.error_key)}
              </p>
            )}
          </div>
        </div>

        <div id="checkout-summary">
          <div className="card card-pad">
            <h2 className="section-title mb-3">{t("web.summary")}</h2>
            <div className="text-sm divide-y divide-line">
              <div className="flex justify-between py-2">
                <span className="text-ink-soft">{t("web.subtotal")}</span>
                <span>{formatIdr(totals.subtotal)}</span>
              </div>
              {/* Modest marker only: the subtotal above is already the sale
                  price, and the full countdown belongs on the product page. */}
              {flashSummary && (
                <div className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-ink-soft">{t("web.flash_applied")}</span>
                  <FlashBadge percent={flashSummary.percent} endsAt={flashSummary.endsAt} />
                </div>
              )}
              {totals.bulk_discount !== "0" && (
                <div className="flex justify-between py-2 text-grass-dark">
                  <span>{t("web.bulk_discount")}</span>
                  <span>−{formatIdr(totals.bulk_discount)}</span>
                </div>
              )}
              {totals.voucher_discount !== "0" && (
                <div className="flex justify-between py-2 text-grass-dark">
                  <span>{t("web.voucher_discount")}</span>
                  <span>−{formatIdr(totals.voucher_discount)}</span>
                </div>
              )}
              {method === "qris" && (
                <div className="flex justify-between py-2">
                  <span className="text-ink-soft">{t("web.qris_admin_fee")}</span>
                  <span>{formatIdr(totals.qris_admin_fee)}</span>
                </div>
              )}
              <div className="flex justify-between py-3 items-baseline">
                <span className="font-semibold">{t("web.order_total")}</span>
                <Price value={method === "qris" ? totals.qris_grand_total : totals.total} fx={ctx?.fx} size="text-lg" />
              </div>
            </div>
            {ctx?.fx && <p className="text-xs text-ink-faint">{t("web.usdt_note")}</p>}
            {/* Desktop only: on a phone this button lives in the sticky bar
                below instead. Rendering it in both places would put two
                identically-labelled submits in the page for assistive tech to
                disambiguate, so only one exists at a time. */}
            {isDesktop && (
              <button
                type="button"
                className="btn btn-primary w-full mt-4"
                disabled={placeOrderDisabled}
                style={placeOrderBlocked ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                onClick={() => placeOrderMutation.mutate()}
              >
                {placeOrderMutation.isPending && <Spinner />}
                {t("web.place_order")} <ChevronRight className="w-4 h-4" />
              </button>
            )}
            <Link to="/cart" className="btn btn-ghost w-full mt-2">
              {t("web.back_to_cart")}
            </Link>
          </div>
        </div>
      </form>

      {/* Sticky mobile total: on a phone the summary card stacks *below* the method
          list, so the buyer chooses a payment rail with the amount they are
          about to pay scrolled off-screen — the one number that should never
          leave view on a checkout. This bar pins the live total (the same
          `totals.total` the summary renders, after any voucher preview) next
          to the only submit control mobile has, and reuses the summary
          button's mutation and gating verbatim: no second request path, no
          second notion of "ready to pay". Desktop keeps the in-card button —
          there the summary sits beside the methods and is already in view. */}
      {!isDesktop && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 px-4 pt-3 backdrop-blur-sm"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <div className="flex items-center gap-3">
            {/* The IDR figure only: the USDT hint stays in the summary card,
                where there is room for it without crowding the button off a
                320px row. */}
            <div className="min-w-0">
              <div className="text-xs text-ink-soft">{t("web.order_total")}</div>
              <div className="text-base font-semibold text-pine truncate">
                {formatIdr(method === "qris" ? totals.qris_grand_total : totals.total)}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary ml-auto shrink-0"
              disabled={placeOrderDisabled}
              style={placeOrderBlocked ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
              onClick={() => placeOrderMutation.mutate()}
            >
              {placeOrderMutation.isPending && <Spinner />}
              {t("web.place_order")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
