/**
 * TSX port of apps/storefront/views/checkout.njk + its embedded totals
 * partial views/_checkout_totals.njk. checkout.njk's inline <script>
 * intercepts Enter on #voucher_code so it previews the voucher instead of
 * submitting the real order (see the onKeyDown handler below) — ported as a
 * plain event handler since none of our buttons are type="submit" anyway.
 *
 * State is split the same way the HTMX swap split the page: `page` (payment
 * method radios + wallet cards) is set ONCE from the initial GET and never
 * touched again — the voucher-preview response only ever swapped
 * #checkout-summary in the NJK, never the method radios. `totals` mirrors
 * that #checkout-summary fragment: initialized from the same GET, then
 * replaced wholesale by every voucher-preview response (subtotal/discounts/
 * total + the method-enabled flags _checkout_totals.njk uses to gate the
 * Place Order button). The voucher input itself is a THIRD, independent
 * piece of state — its live typed value is what Place Order submits,
 * whether or not Apply/Enter was ever pressed, exactly like the NJK's
 * hx-include="closest form" left the input's value untouched by the swap.
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

/** checkout.njk's default-selection cascade: the first enabled method wins,
 * in file/priority order (qris → paydisini → binance → bybit → bybit_bsc →
 * nowpayments). Returns null when no method is enabled at all. */
function defaultMethod(data: CheckoutData): string | null {
  if (data.idr_enabled) return "qris";
  if (data.paydisini_enabled) return "paydisini";
  if (data.binance_enabled) return "binance";
  if (data.bybit_enabled) return "bybit";
  if (data.bybit_bsc_enabled) return "bybit_bsc";
  if (data.nowpayments_enabled) return "nowpayments";
  return null;
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
  return (
    <div className="card card-pad">
      <h2 className="section-title mb-1">{t("web.checkout_info_title")}</h2>
      <p className="text-xs text-ink-soft mb-3">{t("web.checkout_info_intro")}</p>
      <div className="space-y-5">
        {Array.from({ length: qty }, (_, unitIdx) => (
          <div key={unitIdx} className={qty > 1 ? "border border-line rounded-xl p-3" : ""}>
            {qty > 1 && (
              <div className="text-xs font-semibold text-ink-soft mb-2">
                {t("web.checkout_info_unit", { unit: unitIdx + 1, total: qty })}
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
  const [useWalletIdr, setUseWalletIdr] = useState(false);
  const [useWalletUsdt, setUseWalletUsdt] = useState(false);
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

  const placeOrderMutation = useMutation({
    mutationFn: () =>
      apiPost<PlaceOrderResponse>("/api/v1/checkout", {
        method,
        voucher_code: voucherInput,
        use_wallet_idr: useWalletIdr,
        use_wallet_usdt: useWalletUsdt,
        customer_data: page?.items.some((i) => i.delivery_type === "manual_with_info") ? answers : undefined,
      }),
    onSuccess: (resp) => navigate(resp.pay_url),
    onError: (err) => setPlaceOrderErrorKey((err as Error).message),
  });

  if (!page || !totals) return null;

  const hasWalletIdr = Boolean(page.wallet_idr) && page.wallet_idr !== "0";
  const hasWalletUsdt = Boolean(page.wallet_usdt) && page.wallet_usdt !== "0";
  const anyMethod = anyMethodEnabled(totals);
  // Info step (Task 6): the single-SKU-per-non-auto-cart guard means there's
  // ever at most one manual_with_info line.
  const infoItem = page.items.find((i) => i.delivery_type === "manual_with_info") ?? null;
  const infoValid = !infoItem || allFieldsValid(infoItem.additional_fields, answers, infoItem.qty);

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
              {!anyMethodEnabled(page) && (
                <div className="text-center text-sm text-ink-soft border border-dashed border-line rounded-xl py-6 px-3">
                  <Wallet className="w-5 h-5 mx-auto mb-1.5 text-ink-faint" />
                  <p>{t("web.pay_none_available")}</p>
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
          </div>

          {hasWalletIdr && (
            <div className="card card-pad">
              <h2 className="section-title mb-2">{t("web.wallet_label")}</h2>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-pine"
                  checked={useWalletIdr}
                  onChange={(e) => setUseWalletIdr(e.target.checked)}
                />
                <span className="text-sm">{t("web.wallet_use_idr", { amount: formatIdr(page.wallet_idr) })}</span>
              </label>
              <p className="text-xs text-ink-soft mt-1.5">{t("web.wallet_idr_note")}</p>
            </div>
          )}
          {hasWalletUsdt && (
            <div className="card card-pad">
              {!hasWalletIdr && <h2 className="section-title mb-2">{t("web.wallet_label")}</h2>}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-pine"
                  checked={useWalletUsdt}
                  onChange={(e) => setUseWalletUsdt(e.target.checked)}
                />
                <span className="text-sm">
                  {t("web.wallet_use_usdt", { amount: `${money4(page.wallet_usdt)} USDT` })}
                </span>
              </label>
              <p className="text-xs text-ink-soft mt-1.5">{t("web.wallet_usdt_note")}</p>
            </div>
          )}
        </div>

        <div id="checkout-summary">
          {totals.error_key && (
            <div className="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mb-3">
              <AlertTriangle className="w-4 h-4" /> {t(totals.error_key)}
            </div>
          )}
          <div className="card card-pad">
            <h2 className="section-title mb-3">{t("web.summary")}</h2>
            <div className="text-sm divide-y divide-line">
              <div className="flex justify-between py-2">
                <span className="text-ink-soft">{t("web.subtotal")}</span>
                <span>{formatIdr(totals.subtotal)}</span>
              </div>
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
