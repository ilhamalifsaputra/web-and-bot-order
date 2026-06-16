/**
 * Display formatters — bot-presentation parts of bot/utils/formatters.py.
 * Money/code/escape/redact helpers already live in @app/core/formatters;
 * re-exported here for a single import site.
 */
import { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
import { formatIdr, formatPrice, usdtFromIdr } from "@app/core/formatters";
export { esc, redactCredentials, quantizeMoney, formatPrice, formatIdr, usdtFromIdr } from "@app/core/formatters";

/**
 * Catalog price display (plan.md §15.6): the central Rupiah price with the
 * derived USDT info BESIDE it — "Rp79.000 (≈ $4.9)" — or just the Rupiah when
 * no usd_idr_rate is set. Use for product/cart/confirmation amounts; NOT for
 * wallet balances or USDT-order totals (those are USDT figures).
 */
export function priceIdr(v: Decimal.Value, rate: Decimal | null): string {
  return rate ? `${formatIdr(v)} (≈ $${usdtFromIdr(v, rate).toString()})` : formatIdr(v);
}

/**
 * An order's charged total in ITS transaction currency: IDR (TokoPay) orders
 * as "Rp40.000", USDT (Binance) orders — and pre-cutover snapshots — as
 * "2.50 USDT" (the rounded amount Binance actually charges).
 */
export function orderAmount(
  o: { totalAmount: Decimal.Value; currency?: string | null },
  decimals = 2,
): string {
  return (o.currency ?? "USDT") === "IDR"
    ? formatIdr(o.totalAmount)
    : formatPrice(o.totalAmount, "USDT", decimals);
}

/**
 * Per-currency totals as one line: "Rp1.234.000 + 5.00 USDT". Currencies are
 * never summed into one number (plan.md §15.8) — zero buckets are dropped,
 * an all-zero pair renders as "Rp0".
 */
export function mixedAmount(idr: Decimal.Value, usdt: Decimal.Value): string {
  const idrDec = new Decimal(idr);
  const usdtDec = new Decimal(usdt);
  const parts: string[] = [];
  if (idrDec.greaterThan(0) || usdtDec.lessThanOrEqualTo(0)) parts.push(formatIdr(idrDec));
  if (usdtDec.greaterThan(0)) parts.push(formatPrice(usdtDec, "USDT", 2));
  return parts.join(" + ");
}

/**
 * Truncate a string to `max` characters with a trailing ellipsis so it fits
 * safely inside a Telegram inline-button label (Telegram renders ~30 chars per
 * row button; keeping labels under 24 chars prevents visual clipping on most
 * devices).
 */
export function truncLabel(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Remaining time until expiry as "M:SS" (e.g. "4:32"). Port of _format_countdown. */
export function formatCountdown(expiresAt: Date): string {
  const remainingMs = ensureUtc(expiresAt).toMillis() - Date.now();
  const totalSecs = Math.max(0, Math.floor(remainingMs / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

const STATUS_EMOJI: Record<string, string> = {
  pending_payment: "⏳",
  pending_verification: "🔎",
  paid: "💰",
  delivered: "✅",
  cancelled: "❌",
  rejected: "🚫",
  refunded: "↩️",
};

/** "⏳ PENDING PAYMENT" style badge. Accepts the stored (UPPERCASE) status. */
export function statusBadge(status: string): string {
  const emoji = STATUS_EMOJI[status.toLowerCase()] ?? "•";
  return `${emoji} ${status.replace(/_/g, " ").toUpperCase()}`;
}

export interface OrderItemLike {
  productId: number;
  quantity: number;
  unitPrice: Decimal.Value;
  product: { id: number; name: string; durationLabel?: string; type?: string } & Record<string, unknown>;
  stockItem?: { credentials: string } | null;
}

export interface OrderItemGroup {
  product: OrderItemLike["product"];
  quantity: number;
  unitPrice: Decimal;
  lineTotal: Decimal;
  stockItems: Array<{ credentials: string }>;
}

/**
 * Collapse the 1-item-per-unit OrderItems into one row per product for display
 * ("× 5" instead of five "× 1" lines). Port of formatters.group_order_items.
 */
export function groupOrderItems(items: OrderItemLike[]): OrderItemGroup[] {
  const groups = new Map<number, OrderItemGroup>();
  for (const item of items) {
    let g = groups.get(item.productId);
    if (!g) {
      g = {
        product: item.product,
        quantity: 0,
        unitPrice: new Decimal(item.unitPrice),
        lineTotal: new Decimal(0),
        stockItems: [],
      };
      groups.set(item.productId, g);
    }
    g.quantity += item.quantity;
    g.lineTotal = g.lineTotal.plus(new Decimal(item.unitPrice).times(item.quantity));
    if (item.stockItem) g.stockItems.push(item.stockItem);
  }
  return [...groups.values()];
}
