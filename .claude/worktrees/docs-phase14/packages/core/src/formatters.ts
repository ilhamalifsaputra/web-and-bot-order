/**
 * Code generation + money quantization helpers — port of the parts of Python
 * `bot/utils/formatters.py` that the CRUD layer depends on. Presentation-only
 * helpers (status_badge, group_order_items, esc, redact) live with the
 * web/bot layers.
 */
import { randomInt, randomBytes } from "node:crypto";
import { Decimal } from "./money";

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
 * Derived USDT for a central-IDR amount (plan.md §15.1): idr / rate, rounded
 * to the NEAREST 0.1 (16,000/USDT → Rp40.000 = $2.5; $2.453 → $2.5). The
 * rounded value is both what's displayed beside the IDR price and what Binance
 * actually charges. Convert once per displayed price/total — never per
 * component — to avoid double-rounding drift.
 */
export function usdtFromIdr(idr: Decimal.Value, rate: Decimal.Value): Decimal {
  return new Decimal(idr).div(rate).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
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
 * Deterministic amount offset (0.02 … 0.98 USDT) keyed off order id, used to
 * disambiguate simultaneous transfers of the same base amount (M-9).
 *
 * The step (0.02) is deliberately **larger than AMOUNT_TOLERANCE (0.01)** in the
 * payment matchers, which compare `|received − total| <= 0.01`. With a smaller
 * step two equal-base orders stayed within tolerance of each other (both matched
 * → refuse), so the offset never actually disambiguated them. A 0.02 step means
 * adjacent-id orders are ≥0.02 apart → only the intended order matches.
 *
 * Trade-off (offset up to 0.98): orders whose *base* totals differ by < ~0.98
 * USDT can now alias within tolerance and refuse — still safe (manual, never a
 * mis-deliver). 49 buckets keep the surcharge under 1 USDT.
 */
export function computeUniqueCents(orderIdOrSeed: number): Decimal {
  const bucket = (orderIdOrSeed % 49) + 1; // 1..49
  return new Decimal(bucket).div(50).toDecimalPlaces(4); // 0.02 .. 0.98, step 0.02
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
