/**
 * Display formatters — bot-presentation parts of bot/utils/formatters.py.
 * Money/code/escape/redact helpers already live in @app/core/formatters;
 * re-exported here for a single import site.
 */
import { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
export { esc, redactCredentials, quantizeMoney, formatPrice, formatIdr } from "@app/core/formatters";

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
  product: { id: number; name: string; durationLabel?: string } & Record<string, unknown>;
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
