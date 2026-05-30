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
 * Deterministic cents offset (0.0001 … 0.0099) keyed off order id, used to
 * disambiguate simultaneous transfers of the same amount. (id % 99) + 1 / 10000.
 */
export function computeUniqueCents(orderIdOrSeed: number): Decimal {
  const offset = (orderIdOrSeed % 99) + 1;
  return new Decimal(offset).div(10000).toDecimalPlaces(4);
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
