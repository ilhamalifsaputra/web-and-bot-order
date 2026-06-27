/**
 * Display formatters — bot-presentation parts of bot/utils/formatters.py.
 * Money/code/escape/redact helpers already live in @app/core/formatters;
 * re-exported here for a single import site.
 */
import { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
import { formatIdr, formatPrice, usdtFromIdr } from "@app/core/formatters";
import { OrderStatus } from "@app/core/enums";
import { coreT } from "./i18n";
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
  // Bybit BSC on-chain rail only — every other payment method never reaches these.
  payment_detected: "📡",
  confirming: "⏳",
  confirmed: "🔗",
  pending_verification: "🔎",
  paid: "💰",
  delivered: "✅",
  cancelled: "❌",
  rejected: "🚫",
  refunded: "↩️",
  failed: "⚠️",
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

// ---------------------------------------------------------------------------
// Bybit BSC live tracking screen
// ---------------------------------------------------------------------------

/** Block-character progress bar, e.g. "██████░░░░░░░░" for 6/15. */
function progressBar(current: number, total: number, width = 14): string {
  if (total <= 0) return "░".repeat(width);
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Ordered timeline stages for the tracking screen. This screen is only ever
 * shown for the first 3 — DELIVERED (and FAILED/CANCELLED/etc.) render
 * through the existing order.detail path instead — but DELIVERED stays here
 * as the always-pending 4th row so the buyer can see what's still ahead. */
const TRACKING_STAGES = [
  OrderStatus.PAYMENT_DETECTED,
  OrderStatus.CONFIRMING,
  OrderStatus.CONFIRMED,
  OrderStatus.DELIVERED,
] as const;

const TRACKING_ROW_LABEL_KEYS: Record<string, string> = {
  [OrderStatus.PAYMENT_DETECTED]: "order.tracking_row_detected",
  [OrderStatus.CONFIRMING]: "order.tracking_row_confirming",
  [OrderStatus.CONFIRMED]: "order.tracking_row_confirmed",
  [OrderStatus.DELIVERED]: "order.tracking_row_delivered",
};

export interface BybitBscTrackedOrder {
  orderCode: string;
  status: string;
  network: string | null;
  confirmations: number | null;
  requiredConfirmations: number | null;
}

/**
 * Live single-bubble tracking screen for a Bybit BSC order mid-confirmation
 * (PAYMENT_DETECTED/CONFIRMING/CONFIRMED only — viewOrder() routes every
 * other status through the existing order.detail/pending_payment_detail
 * paths). Pure — derives the timeline purely from `order.status`'s position
 * in TRACKING_STAGES, never from OrderStatusHistory (that stays the audit
 * trail, not the render data source) or an extra DB query.
 *
 * The confirmation line is shown only when `order.confirmations != null` —
 * that null check is the literal mechanism preventing a fabricated count;
 * every other payment rail never sets this field, and even Bybit BSC orders
 * have a brief window right after detection before the tracker's first tick.
 */
export function renderBybitBscTrackingScreen(order: BybitBscTrackedOrder, lang: string): string {
  const stageIdx = TRACKING_STAGES.indexOf(order.status as (typeof TRACKING_STAGES)[number]);
  const timeline = TRACKING_STAGES.map((stage, i) => {
    const glyph = stageIdx < 0 ? "⬜" : i < stageIdx ? "✅" : i === stageIdx ? "⏳" : "⬜";
    return `${glyph} ${coreT(TRACKING_ROW_LABEL_KEYS[stage]!, lang)}`;
  }).join("\n");

  const confirmationsLine =
    order.confirmations != null
      ? coreT("order.tracking_confirmations_line", lang, {
          bar: progressBar(order.confirmations, order.requiredConfirmations ?? 15),
          confirmations: order.confirmations,
          required: order.requiredConfirmations ?? 15,
        })
      : coreT("order.tracking_awaiting_count", lang);

  return coreT("order.tracking_detail", lang, {
    code: order.orderCode,
    asset: "USDT",
    network: order.network ?? "BSC",
    status: statusBadge(order.status),
    confirmations_line: confirmationsLine,
    timeline,
  });
}
