/** Browser-only Decimal money rendering. Runtime dependencies are declared
 * directly; no server/core imports cross the frontend boundary. */
import Decimal from "decimal.js";
import { currentLang } from "./i18n";

/** The SPA shell sets html.lang from the actual shop language. Pure server-side
 * tests without a DOM retain legacy defaults unless a language is supplied. */
function pageLanguage(): string | undefined {
  return typeof document === "undefined" || !document.documentElement.lang ? undefined : currentLang();
}
function groupDigits(plain: string, lang: string): string {
  const [whole = "0", fraction] = plain.split(".");
  const isId = lang.toLowerCase().startsWith("id");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, isId ? "." : ",");
  return fraction === undefined ? grouped : `${grouped}${isId ? "," : "."}${fraction}`;
}
function decimalValue(value: string | number | null | undefined): Decimal | null {
  if (value == null || value === "") return null;
  try { const result = new Decimal(value); return result.isFinite() ? result : null; } catch { return null; }
}
function usdText(value: Decimal, lang: string): string {
  const rounded = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return `${rounded.isNegative() && !rounded.isZero() ? "-" : ""}$${groupDigits(rounded.abs().toFixed(2), lang)}`;
}

/** Central IDR price: "Rp79.000". "—" for null/empty. Mirrors the `idr` filter. */
export function formatIdr(value: string | number | null | undefined, lang = pageLanguage()): string {
  if (value == null || value === "") return "\u2014";
  const amount = decimalValue(value);
  if (amount === null) return String(value);
  const whole = amount.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return `${whole.isNegative() && !whole.isZero() ? "-" : ""}Rp${groupDigits(whole.abs().toFixed(0), lang ?? "id")}`;
}

/** Derived USD hint: Decimal ceiling to the next 0.01, matching the payable
 * quote. Always two decimals in the current page language. Hidden for missing
 * rates and non-positive amounts. */
export function formatUsdt(
  idrValue: string | number | null | undefined,
  rate: string | number | null | undefined,
  lang = pageLanguage(),
): string {
  const idr = decimalValue(idrValue);
  const fx = decimalValue(rate);
  if (idr === null || fx === null || !fx.greaterThan(0)) return "";
  const usdt = idr.div(fx).toDecimalPlaces(2, Decimal.ROUND_CEIL);
  return usdt.lessThan("0.01") ? "" : `\u2248 ${usdText(usdt, lang ?? "en")}`;
}

/**
 * Native USDT amount for display: up to 4dp, half-up, trailing zeros
 * stripped, whole values with no decimal point at all — "0", "1", "1.5",
 * "12.34", "96.7", "123.4568". "—" for null/empty. Mirrors
 * packages/core/formatters.ts's formatUsdtAmount, byte-for-byte.
 */
export function formatUsdtAmount(value: string | number | null | undefined): string {
  if (value == null || value === "") return "\u2014";
  const amount = decimalValue(value);
  return amount === null ? String(value) : amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
}

/** formatUsdtAmount with the " USDT" suffix, e.g. "12.34 USDT". "—" for null/empty. */
export function formatNativeUsdt(value: string | number | null | undefined): string {
  const amount = formatUsdtAmount(value);
  return amount === "—" ? amount : `${amount} USDT`;
}

/** Primary catalog/cart price in the viewer's display currency, with exact
 * Decimal rounding and actual page-language separators. USD quotes round up to
 * 0.01 exactly as the payable quote; missing/invalid FX falls back to IDR. An
 * order's already-converted native amount goes through formatOrderAmount. */
export function formatPriceFor(
  idrValue: string | number | null | undefined,
  currency: "USD" | "IDR" | null | undefined,
  fx: string | number | null | undefined,
  lang = pageLanguage(),
): string {
  const idr = decimalValue(idrValue);
  const rate = decimalValue(fx);
  if (currency !== "USD" || idr === null || rate === null || !rate.greaterThan(0)) return formatIdr(idrValue, lang);
  return usdText(idr.div(rate).toDecimalPlaces(2, Decimal.ROUND_CEIL), lang ?? "en");
}

/**
 * True when {@link formatPriceFor} will actually render a "$" figure for this
 * viewer — a `"USD"` preference AND a usable rate. Mirrors the bot's
 * `userPriceFormatter().showsUsd` (apps/order-bot/src/util/format.ts), which
 * probes the same way (format 0, look at what came out) so the two can never
 * disagree about when the rate-missing fallback kicked in. Used to gate the
 * "Price $X · Pay RpY" line on IDR-rail pay surfaces: with no usable rate the
 * display price already fell back to Rp, so a dual line would say nothing.
 */
export function showsUsdDisplay(
  currency: "USD" | "IDR" | null | undefined,
  fx: string | number | null | undefined,
): boolean {
  return currency === "USD" && formatPriceFor(0, currency, fx).startsWith("$");
}

/**
 * The checkout method tokens (PaymentMethodSelector's radio values) whose
 * charge settles in Rupiah and so get the "Price $X · Pay RpY" line for a
 * USD-preference viewer — QRIS/TokoPay, PayDisini and the IDR wallet debit.
 * `wallet_idr` isn't a "rail" in the gateway sense (it's a synchronous balance
 * debit, no fee), but it is still an IDR-settled charge a USD viewer needs
 * anchored to the Rupiah figure actually leaving their balance. USDT rails
 * and `wallet_usdt` charge natively in the currency the viewer already sees.
 */
export function isIdrRail(method: string | null | undefined): boolean {
  return method === "qris" || method === "paydisini" || method === "wallet_idr";
}

/**
 * An order's OWN settlement-currency amount — `order.total`,
 * `order.qris_admin_fee`, a linked ticket order's `total`, etc. (see
 * api/types.ts's `PayData`/`TicketOrderSummary`). `orderCurrency` is the
 * order's stored rail currency ("IDR" | "USDT"), NEVER the viewer's
 * display-currency preference — do not run this through
 * {@link formatPriceFor}'s conversion, that would double-convert an amount
 * that is already denominated in whatever the order actually settled in.
 *
 * Task 5 bug fix: PayPage.tsx and TicketOrderSummaryCard.tsx used to call
 * formatIdr on these fields unconditionally, which mis-renders a USDT
 * order's total as if it were a Rupiah figure.
 */
export function formatOrderAmount(
  value: string | number | null | undefined,
  orderCurrency: string | null | undefined,
): string {
  return orderCurrency === "USDT" ? formatNativeUsdt(value) : formatIdr(value);
}
