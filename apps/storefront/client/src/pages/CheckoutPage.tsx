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
 * renames (docs/REACT_STOREFRONT_MIGRATION.md). checkout.njk's payment
 * method `<label>`s have no `has-[:checked]:` styling (that pattern only
 * exists on product.njk's DenominationCard) — ported as-is, template wins.
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Wallet } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { AdditionalField, CheckoutData, PlaceOrderResponse } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { formatIdr, money4 } from "../lib/format";
import { allFieldsValid } from "../lib/deliveryFields";
import FlashBadge, { flashPercentLabel } from "../components/shop/FlashBadge";
import Price from "../components/shop/Price";
import Stepper from "../components/shop/Stepper";
import DeliveryFieldInput from "../components/shop/DeliveryFieldInput";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

/** All-or-nothing wallet-credit gates: only "sufficient" when the balance
 * covers the live total outright — never offered as a partial discount. */
function isIdrWalletSufficient(data: CheckoutData): boolean {
  return Number(data.total) > 0 && Number(data.wallet_idr) >= Number(data.total);
}
function isUsdtWalletSufficient(data: CheckoutData): boolean {
  return data.total_usdt != null && Number(data.wallet_usdt) >= Number(data.total_usdt);
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
                    className="text-xs font-medium text-pine hover:text-pine-dark underline shrink-0"
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

export default function CheckoutPage() {
  const navigate = useNavigate();
  const { data: ctx } = useShopContext();
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
  // One answer-map per unit for the manual_with_info info step — [] when the
  // cart has no such line (the section then renders nothing).
  const [answers, setAnswers] = useState<Array<Record<string, string>>>([]);

  // currentCustomer's 401 → a full page load to /login, matching every other
  // ported page's redirect (not navigate(), so the shell re-serves fresh CSRF).
  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=/checkout");
    }
  }, [error]);

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

  // Empty cart → the server's 303 to /cart, ported as a client-side redirect.
  useEffect(() => {
    if (data?.items_empty) navigate("/cart");
  }, [data, navigate]);

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
      }),
    onSuccess: (resp) => navigate(resp.pay_url),
    onError: (err) => setPlaceOrderErrorKey((err as Error).message),
  });

  if (!page || !totals) return null;

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
          <AlertTriangle className="w-4 h-4" /> {t(placeOrderErrorKey)}
        </div>
      )}

      <form onSubmit={(e) => e.preventDefault()} className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
          {infoItem && (
            <InfoStepCard fields={infoItem.additional_fields} qty={infoItem.qty} answers={answers} onChange={setAnswer} />
          )}

          <div className="card card-pad">
            <h2 className="section-title mb-3">{t("web.pay_method")}</h2>
            <div className="space-y-3">
              {page.idr_enabled && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="qris"
                    className="mt-1"
                    checked={method === "qris"}
                    onChange={() => setMethod("qris")}
                  />
                  <img
                    src="/static/pay/qris.png"
                    alt="QRIS"
                    className="h-7 w-auto max-w-[80px] object-contain shrink-0 mt-0.5"
                  />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_idr_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">{t("web.pay_idr_sub")}</span>
                  </span>
                </label>
              )}
              {page.paydisini_enabled && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="paydisini"
                    className="mt-1"
                    checked={method === "paydisini"}
                    onChange={() => setMethod("paydisini")}
                  />
                  <img
                    src="/static/pay/qris.png"
                    alt="PayDisini"
                    className="h-7 w-auto max-w-[80px] object-contain shrink-0 mt-0.5"
                  />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_paydisini_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">{t("web.pay_paydisini_sub")}</span>
                  </span>
                </label>
              )}
              {page.binance_enabled && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="binance"
                    className="mt-1"
                    checked={method === "binance"}
                    onChange={() => setMethod("binance")}
                  />
                  <img src="/static/pay/binance.png" alt="Binance" className="h-7 w-7 object-contain shrink-0 mt-0.5" />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_usdt_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">{t("web.pay_usdt_sub")}</span>
                  </span>
                </label>
              )}
              {page.bybit_enabled && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="bybit"
                    className="mt-1"
                    checked={method === "bybit"}
                    onChange={() => setMethod("bybit")}
                  />
                  <img
                    src="/static/pay/bybit.png"
                    alt="Bybit"
                    className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
                  />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_bybit_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">{t("web.pay_bybit_sub")}</span>
                  </span>
                </label>
              )}
              {page.bybit_bsc_enabled && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="bybit_bsc"
                    className="mt-1"
                    checked={method === "bybit_bsc"}
                    onChange={() => setMethod("bybit_bsc")}
                  />
                  <img
                    src="/static/pay/bybit.png"
                    alt="Bybit"
                    className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
                  />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_bybit_bsc_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">{t("web.pay_bybit_bsc_sub")}</span>
                  </span>
                </label>
              )}
              {page.nowpayments_enabled && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="nowpayments"
                    className="mt-1"
                    checked={method === "nowpayments"}
                    onChange={() => setMethod("nowpayments")}
                  />
                  <img
                    src="/static/pay/nowpayments.png"
                    alt="NOWPayments"
                    className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
                  />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_nowpayments_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">{t("web.pay_nowpayments_sub")}</span>
                  </span>
                </label>
              )}
              {idrWalletSufficient && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="wallet_idr"
                    className="mt-1"
                    checked={method === "wallet_idr"}
                    onChange={() => setMethod("wallet_idr")}
                  />
                  <Wallet className="h-7 w-7 object-contain shrink-0 mt-0.5 text-pine" />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_wallet_idr_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">
                      {t("web.pay_wallet_idr_sub", { amount: formatIdr(page.wallet_idr) })}
                    </span>
                  </span>
                </label>
              )}
              {usdtWalletSufficient && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line hover:border-pine cursor-pointer">
                  <input
                    type="radio"
                    name="method"
                    value="wallet_usdt"
                    className="mt-1"
                    checked={method === "wallet_usdt"}
                    onChange={() => setMethod("wallet_usdt")}
                  />
                  <Wallet className="h-7 w-7 object-contain shrink-0 mt-0.5 text-pine" />
                  <span>
                    <span className="font-semibold text-sm block">{t("web.pay_wallet_usdt_title")}</span>
                    <span className="text-xs text-ink-soft block mt-0.5">
                      {t("web.pay_wallet_usdt_sub", { amount: `${money4(page.wallet_usdt)} USDT` })}
                    </span>
                  </span>
                </label>
              )}
              {!anyMethodEnabled(page) && !idrWalletSufficient && !usdtWalletSufficient && (
                <div className="text-center text-sm text-ink-soft border border-dashed border-line rounded-xl py-6 px-3">
                  <Wallet className="w-5 h-5 mx-auto mb-1.5 text-ink-faint" />
                  <p>
                    {t("web.pay_none_available_prefix")}{" "}
                    <Link to="/account/support" className="text-pine underline hover:text-pine-dark">
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
              <div className="flex justify-between py-3 items-baseline">
                <span className="font-semibold">{t("web.order_total")}</span>
                <Price value={totals.total} fx={ctx?.fx} size="text-lg" />
              </div>
            </div>
            {ctx?.fx && <p className="text-xs text-ink-faint">{t("web.usdt_note")}</p>}
            <button
              type="button"
              className="btn btn-primary w-full mt-4"
              disabled={!anyMethod || placeOrderMutation.isPending || !infoValid}
              style={!anyMethod || !infoValid ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
              onClick={() => placeOrderMutation.mutate()}
            >
              {placeOrderMutation.isPending && <Spinner />}
              {t("web.place_order")} <ChevronRight className="w-4 h-4" />
            </button>
            <Link to="/cart" className="btn btn-ghost w-full mt-2">
              {t("web.back_to_cart")}
            </Link>
          </div>
        </div>
      </form>
    </>
  );
}
