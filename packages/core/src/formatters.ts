/**
 * Code generation + money quantization helpers — port of the parts of Python
 * `bot/utils/formatters.py` that the CRUD layer depends on. Presentation-only
 * helpers (status_badge, group_order_items, esc, redact) live with the
 * web/bot layers.
 */
import { randomInt, randomBytes } from "node:crypto";
import { Decimal } from "./money";
import { DisplayCurrency } from "./enums";

/** Round to `decimals` places, half-up (matches Python quantize_money). */
export function quantizeMoney(amount: Decimal.Value, decimals = 2): Decimal {
  return new Decimal(amount).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}

/** e.g. "5.07 USDT" */
export function formatPrice(
  amount: Decimal.Value,
  currency = "USDT",
  decimals = 2,
): string {
  return `${quantizeMoney(amount, decimals).toFixed(decimals)} ${currency}`;
}

/**
 * Native USDT amount for display: up to 4dp, half-up, trailing zeros
 * stripped, whole values with no decimal point at all — "0", "1", "1.5",
 * "12.34", "96.7", "123.4568". Distinct from formatPrice (fixed-width
 * decimals): use this for USDT wallet/order/payment amounts so they never
 * carry misleading trailing zeros.
 */
export function formatUsdtAmount(amount: Decimal.Value): string {
  return new Decimal(amount).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
}

/** formatUsdtAmount with the " USDT" suffix, e.g. "12.34 USDT". */
export function formatUsdt(amount: Decimal.Value): string {
  return `${formatUsdtAmount(amount)} USDT`;
}

/**
 * Indonesian Rupiah display, e.g. "Rp123.456" (prefix symbol, dotted
 * thousands, no decimals). formatPrice can't represent this layout (it emits a
 * suffix currency with a decimal point), so IDR rendering routes through this
 * single helper instead of ad-hoc `toLocaleString` calls. Decimal-based — the
 * caller passes an already-converted IDR amount.
 */
export function formatIdr(amount: Decimal.Value): string {
  const whole = new Decimal(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const digits = whole.abs().toFixed(0);
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${whole.isNegative() ? "-" : ""}Rp${grouped}`;
}

/**
 * Currency-aware money display for any `Order.currency` value: "IDR" routes
 * through {@link formatIdr} (Rp prefix, dotted thousands); anything else
 * (USDT today, any future non-ISO code) is a 2dp amount + code suffix via
 * {@link formatPrice}. Deliberately NOT `Intl.NumberFormat(..., {style:
 * "currency"})` — that throws on a non-ISO-4217 code like "USDT", which is
 * most of what this system actually stores.
 */
export function formatMoney(amount: Decimal.Value, currency: string): string {
  return currency === "IDR" ? formatIdr(amount) : formatPrice(amount, currency, 2);
}

/**
 * Derived USDT for a central-IDR amount (plan.md §15.1): idr / rate, rounded
 * UP to the next 0.01 (16,000/USDT → Rp40.000 = $2.50 exactly; Rp44.500 =
 * 2.78125 → $2.79). The rounded value is both what's displayed beside the IDR
 * price and what the crypto rails actually charge. Convert once per displayed
 * price/total — never per component — to avoid double-rounding drift.
 *
 * WHY CEILING, AND WHY 0.01 (M13 / P2-1, a deliberate pricing-policy change
 * from step-0.1 half-up). Rupiah is the source of truth; every USDT figure is
 * a derived quote the shop has to honour. Half-up rounded half of those quotes
 * DOWN, so the shop systematically undercharged on half of its crypto sales —
 * by up to 0.05 USDT a time at the old step, which on a cheap order was a
 * double-digit percentage of the sale. Ceiling never undercharges: rounding
 * always lands in the platform's favour. Cutting the step from 0.1 to 0.01
 * pays for that by making the worst-case overcharge 0.01 rather than 0.1, so
 * the buyer is closer to the true converted price than they were before, not
 * further from it.
 *
 * Two consequences worth knowing before touching anything downstream:
 *  - No positive Rupiah amount converts away to zero any more. `Rp700 → 0.0`
 *    was the case `orderMinimums.ts` was built around; it is now `0.05`, and
 *    that module's `nothing_to_collect` backstop has become a guard against a
 *    genuinely zero total rather than against rounding.
 *  - Two Rupiah totals one cent apart in USDT can no longer be told apart by
 *    the unique-cents offset alone, because that offset's range (0.002 …
 *    0.098) is now wider than the step. That does not weaken payment matching
 *    — every producible total is still an even multiple of 0.001 and so at
 *    least 0.002 from any other, comfortably outside `AMOUNT_TOLERANCE` — and
 *    `finalizeOrderPayment`'s Bybit collision loop compares final totals, not
 *    offsets. There is a regression test pinning both halves of that argument.
 */
export function usdtFromIdr(idr: Decimal.Value, rate: Decimal.Value): Decimal {
  return new Decimal(idr).div(rate).toDecimalPlaces(2, Decimal.ROUND_CEIL);
}

/**
 * Derived IDR for a USDT amount: usdt × rate, UNROUNDED. The inverse of
 * {@link usdtFromIdr}, but deliberately not its mirror: usdtFromIdr rounds
 * because its result is charged/displayed as a real quote, while this one
 * exists only as a COMPARISON OPERAND (e.g. judging a USDT wallet top-up
 * against the shop-wide Rupiah floor) — rounding it would move whatever
 * it's compared against by up to half a Rupiah. Callers that need a
 * roundable, displayable IDR figure should not use this helper as-is; none
 * do today.
 */
export function idrFromUsdt(usdt: Decimal.Value, rate: Decimal.Value): Decimal {
  return new Decimal(usdt).times(rate);
}

/** Result of converting a canonical IDR amount into a user's display currency. */
export type DisplayConversion =
  | { ok: true; currency: DisplayCurrency; amount: Decimal }
  | { ok: false; reason: "rate_unavailable" };

/** A rate usable for USD display: present, finite and strictly positive. */
function usableRate(fx: Decimal.Value | null | undefined): Decimal | null {
  if (fx == null) return null;
  let rate: Decimal;
  try {
    rate = new Decimal(fx);
  } catch {
    return null;
  }
  return rate.isFinite() && rate.gt(0) ? rate : null;
}

/**
 * Convert a canonical IDR amount for DISPLAY in `currency` (the user's
 * `preferredCurrency`). IDR is returned unchanged. USD is {@link usdtFromIdr}
 * — the same ceil-to-0.01 quote the USDT rails charge, so the displayed price
 * never disagrees with the invoice. When the rate is missing/stale (callers
 * pass `getUsdIdrRate`'s null through), zero, negative or non-finite, the
 * result is `rate_unavailable` — a rate is never invented.
 */
export function convertIdrToDisplay(
  idrAmount: Decimal.Value,
  currency: DisplayCurrency,
  fx: Decimal.Value | null | undefined,
): DisplayConversion {
  if (currency === DisplayCurrency.IDR) {
    return { ok: true, currency: DisplayCurrency.IDR, amount: new Decimal(idrAmount) };
  }
  const rate = usableRate(fx);
  if (!rate) return { ok: false, reason: "rate_unavailable" };
  return { ok: true, currency: DisplayCurrency.USD, amount: usdtFromIdr(idrAmount, rate) };
}

/** "$1,250.00" — 2dp, comma thousands. Decimal-based, never a float. */
function formatUsdDisplay(amount: Decimal): string {
  const fixed = amount.abs().toFixed(2, Decimal.ROUND_HALF_UP);
  const [whole, cents] = fixed.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount.isNegative() && !amount.isZero() ? "-" : ""}$${grouped}.${cents}`;
}

/** What {@link formatDisplayMoneyResult} rendered: `currency` is the currency
 * actually shown, and `fellBack` is true when USD was asked for but the rate
 * was unavailable so the explicit IDR string was shown instead. */
export interface DisplayMoneyText {
  text: string;
  currency: DisplayCurrency;
  fellBack: boolean;
}

/**
 * Render a canonical IDR amount in the user's display currency: IDR →
 * {@link formatIdr} ("Rp79.000"); USD → "$4.94". If USD is requested without a
 * usable rate the text falls back to the explicit "Rp…" string — never a bare
 * number and never a "$" figure derived without a rate.
 */
export function formatDisplayMoneyResult(
  idrAmount: Decimal.Value,
  currency: DisplayCurrency,
  fx: Decimal.Value | null | undefined,
): DisplayMoneyText {
  const conv = convertIdrToDisplay(idrAmount, currency, fx);
  if (conv.ok && conv.currency === DisplayCurrency.USD) {
    return { text: formatUsdDisplay(conv.amount), currency: DisplayCurrency.USD, fellBack: false };
  }
  return { text: formatIdr(idrAmount), currency: DisplayCurrency.IDR, fellBack: !conv.ok };
}

/** {@link formatDisplayMoneyResult}'s text only. */
export function formatDisplayMoney(
  idrAmount: Decimal.Value,
  currency: DisplayCurrency,
  fx: Decimal.Value | null | undefined,
): string {
  return formatDisplayMoneyResult(idrAmount, currency, fx).text;
}

const ORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

function pick(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Build a human-friendly order code: ORD-YYYYMMDD-XXXX (UTC date). */
export function generateOrderCode(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `ORD-${y}${m}${d}-${pick(ORD_ALPHABET, 4)}`;
}

/** 8-char referral code, no ambiguous characters. */
export function generateReferralCode(): string {
  return pick(REF_ALPHABET, 8);
}

/**
 * 10-char uppercase hex payment reference (e.g. "BCC1BDDE6F") — the note a buyer
 * includes on a Binance Internal Transfer so the poller can match it to an order.
 * Short enough to type as a memo; ~1.1e12 space makes collisions negligible
 * (the caller still retries on the UNIQUE constraint).
 */
export function generatePaymentRef(): string {
  return randomBytes(5).toString("hex").toUpperCase();
}

/**
 * Deterministic amount offset (0.002 … 0.098 USDT) keyed off order id, used to
 * disambiguate simultaneous transfers of the same base amount (M-9).
 *
 * The step (0.002) is deliberately **larger than AMOUNT_TOLERANCE (0.001)** in
 * the payment matchers, which compare `|received − total| <= 0.001`. With a
 * smaller step two equal-base orders stayed within tolerance of each other
 * (both matched → refuse), so the offset never actually disambiguated them. A
 * 0.002 step means adjacent-id orders are ≥0.002 apart → only the intended
 * order matches.
 *
 * Originally 0.02 .. 0.98 (step 0.02, tolerance 0.01): negligible on a
 * big-ticket order but up to a 49% surcharge on a cheap ($2-ish) one. Both the
 * step and the tolerance were shrunk 10x to cut the worst case to ~0.1 USDT
 * while keeping the same 49 buckets and the same step/tolerance safety margin
 * (still safe if collisions happen anyway — manual review, never a
 * mis-deliver).
 *
 * M13 / P2-1 note: the 0.002-vs-0.001 margin above is about ADJACENT OFFSETS,
 * which is only half the question now that {@link usdtFromIdr} rounds to 0.01
 * instead of 0.1. The offset range (0.096 wide) is now wider than the base
 * step, so two different Rupiah totals CAN land on the same final amount — but
 * they can never land within 0.001 of each other without being equal, because
 * a base is a whole number of cents and an offset is a whole number of
 * 0.002s, making every producible total an even multiple of 0.001. Exact ties
 * are handled where they always were: `finalizeOrderPayment` re-rolls the
 * offset until no other pending order on the same rail shares the total. Both
 * halves of this are pinned by tests in core.test.ts — read them before
 * changing either constant or the rounding step.
 */
export function computeUniqueCents(orderIdOrSeed: number): Decimal {
  const bucket = (orderIdOrSeed % 49) + 1; // 1..49
  return new Decimal(bucket).div(500).toDecimalPlaces(4); // 0.002 .. 0.098, step 0.002
}

/** Escape user text for Telegram HTML (quote=False — only & < >). */
export function esc(text: string | null | undefined): string {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Redact credentials for safe logging: user@x.com:pw -> u***@x***:***. */
export function redactCredentials(creds: string): string {
  if (!creds) return "";
  const parts = creds.replace(/\|/g, ":").split(":");
  const redacted = parts.map((raw) => {
    const p = raw.trim();
    if (p.includes("@")) {
      const [local, domain] = p.split("@");
      return `${(local ?? "").slice(0, 1)}***@${(domain ?? "").slice(0, 1)}***`;
    }
    return p ? "***" : "";
  });
  return redacted.join(":");
}
