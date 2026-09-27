/**
 * Display formatters — bot-presentation parts of bot/utils/formatters.py.
 * Money/code/escape/redact helpers already live in @app/core/formatters;
 * re-exported here for a single import site.
 */
import { Decimal } from "@app/core/money";
import { ensureUtc, addDays } from "@app/core/datetime";
import {
  formatIdr,
  formatPrice,
  formatUsdt,
  usdtFromIdr,
  formatDisplayMoneyResult,
  type DisplayMoneyText,
} from "@app/core/formatters";
import { esc } from "@app/core/formatters";
import { formatCompactPrice } from "@app/core/compactFormat";
import { OrderStatus, DisplayCurrency, parseDisplayCurrency } from "@app/core/enums";
import { coreT } from "./i18n";
export {
  esc,
  redactCredentials,
  quantizeMoney,
  formatPrice,
  formatIdr,
  formatUsdt,
  formatUsdtAmount,
  usdtFromIdr,
} from "@app/core/formatters";
export { formatCompactQty, formatCompactPrice } from "@app/core/compactFormat";

/**
 * Legacy "Rp79.000 (≈ $4.94)" string, independent of any user preference.
 * Catalog/detail/confirmation screens no longer use it — they go through
 * {@link formatUserPrice}/{@link userPriceFormatter}. It remains only for the
 * order-detail item lines (an order snapshot, which must read the same
 * whatever display currency the buyer picks later).
 */
export function priceIdr(v: Decimal.Value, rate: Decimal | null): string {
  return rate ? `${formatIdr(v)} (≈ $${usdtFromIdr(v, rate).toString()})` : formatIdr(v);
}

// ---------------------------------------------------------------------------
// Display-currency price rendering (the single render-edge entry point)
// ---------------------------------------------------------------------------

/**
 * Catalog price in the user's display currency. `idr` MUST be a canonical
 * IDR amount (catalog price, flash price, cart/confirmation subtotal,
 * voucher value, minimum purchase): it is converted exactly once here —
 * never pass an amount that is already USDT/rail currency.
 *
 * - USD → "$4.94" (usdtFromIdr, ceil 0.01 — the figure the USDT rails charge).
 * - IDR → "Rp79.000" only (no "≈ $" hint).
 * - NULL/unknown preference → IDR-labelled, never USD.
 * - USD with no usable rate → explicit "Rp…" and `fellBack: true`.
 */
export function formatUserPrice(
  currency: DisplayCurrency | null | undefined,
  idr: Decimal.Value,
  rate: Decimal | null,
): DisplayMoneyText {
  return formatDisplayMoneyResult(idr, parseDisplayCurrency(currency) ?? DisplayCurrency.IDR, rate);
}

/** One screen's price renderer, bound to a display currency and the rate
 * fetched once for that screen (currentUsdtRate). Never cache its output in
 * the session — screens re-render from DB values. */
export interface UserPriceFormatter {
  /** The effective display currency asked for (NULL preference → IDR). */
  readonly currency: DisplayCurrency;
  /** True when prices on this screen actually render in $. */
  readonly showsUsd: boolean;
  /** USD was asked for but the rate is unavailable, so Rp is shown instead. */
  readonly fellBack: boolean;
  /** Full price text for a canonical IDR amount. */
  price(idr: Decimal.Value): string;
  /** Short price for inline-button labels: "Rp79K" (IDR) or "$4.94" (USD). */
  compact(idr: Decimal.Value): string;
  /** "\n\n<currency.rate_unavailable>" when fellBack, else "" — append once per screen. */
  rateNotice(lang: string): string;
}

export function userPriceFormatter(
  currency: DisplayCurrency | null | undefined,
  rate: Decimal | null,
): UserPriceFormatter {
  const effective = parseDisplayCurrency(currency) ?? DisplayCurrency.IDR;
  // The rate is fixed for the screen, so whether USD renders is too — probe once.
  const probe = formatDisplayMoneyResult(0, effective, rate);
  const showsUsd = probe.currency === DisplayCurrency.USD;
  const fellBack = probe.fellBack;
  return {
    currency: effective,
    showsUsd,
    fellBack,
    price: (idr) => formatDisplayMoneyResult(idr, effective, rate).text,
    compact: (idr) => (showsUsd ? formatDisplayMoneyResult(idr, effective, rate).text : formatCompactPrice(idr)),
    rateNotice: (lang) => (fellBack ? `\n\n${coreT("currency.rate_unavailable", lang)}` : ""),
  };
}

/** {@link userPriceFormatter} for the ctx's own user (session.dbUser.preferredCurrency). */
export function ctxPriceFormatter(
  ctx: { session: { dbUser?: { preferredCurrency?: DisplayCurrency | null } | null } },
  rate: Decimal | null,
): UserPriceFormatter {
  return userPriceFormatter(ctx.session.dbUser?.preferredCurrency ?? null, rate);
}

/**
 * Payment screens stay truthful: the payable is always the rail's own figure
 * (`payText`, already formatted in the rail currency). When the user's
 * display currency differs from it (a USD user on an IDR rail), add one line
 * showing both — "Price $9.80 · Pay Rp160.000" — with the price derived from
 * the order's canonical IDR total (pre-fee, converted once) and Pay the rail's
 * existing fee-inclusive charge. Labelled "Price", not "Total", since the two
 * figures differ by the rail fee. Never re-derives the payable. Returns ""
 * when the display currency already matches (IDR/NULL user, or no rate).
 */
export function payAlongsidePriceLine(
  fmt: UserPriceFormatter,
  priceIdrAmount: Decimal.Value,
  payText: string,
  lang: string,
): string {
  if (!fmt.showsUsd) return "";
  return `\n\n${coreT("checkout.price_and_pay", lang, { price: fmt.price(priceIdrAmount), pay: payText })}`;
}

/**
 * A ValidationError's format args with any IDR-canonical money converted for
 * display. Only `error.voucher_min_purchase` carries one today (the voucher's
 * minPurchase, a raw IDR decimal string); every other key's args are returned
 * as-is (same object).
 */
export function displayValidationArgs(
  key: string,
  args: Record<string, unknown>,
  fmt: UserPriceFormatter,
): Record<string, unknown> {
  if (key === "error.voucher_min_purchase" && args.min != null) {
    return { ...args, min: fmt.price(String(args.min)) };
  }
  return args;
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
  if (usdtDec.greaterThan(0)) parts.push(formatUsdt(usdtDec));
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

/**
 * Coarse "time left" for a flash sale, e.g. "2d 5h", "5h 12m", "12m", "<1m".
 * Deliberately NOT formatCountdown's "M:SS" — a sale runs for hours or days, and
 * a bot message can't tick, so a stale "132:07" would be both wrong and
 * unreadable. Returns "<1m" rather than a negative or zero value; callers only
 * render this while the sale is still live.
 */
export function formatFlashRemaining(endsAt: Date, now: Date = new Date()): string {
  const totalMins = Math.floor((ensureUtc(endsAt).toMillis() - now.getTime()) / 60000);
  if (totalMins < 1) return "<1m";
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
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
  // Manual/manual_with_info order paid and awaiting hand-fulfilment (Task 9).
  processing: "⏳",
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

export interface TicketOrderLike {
  orderCode: string;
  status: string;
  deliveredAt: Date | null;
  items: (OrderItemLike & { warrantyDaysSnapshot: number })[];
}

export interface TicketOrderSummary {
  orderCode: string;
  statusBadge: string;
  productLine: string;
  warranty: { active: boolean; untilDisplay: string } | null;
}

/**
 * Condensed order facts for a ticket's linked order — a few lines for a chat
 * bubble, not the full viewOrder() card (which branches on payment
 * countdowns, credentials, manual-fields — none relevant inside a ticket).
 * Warranty is computed from the FIRST item's warrantyDaysSnapshot only: a
 * ticket's linked order is normally single-product, and a multi-product
 * order with divergent per-item warranty windows is a rare edge this
 * condensed line doesn't attempt to fully resolve.
 */
export function summarizeTicketOrder(order: TicketOrderLike): TicketOrderSummary {
  const groups = groupOrderItems(order.items);
  const g = groups[0];
  const productLine = g ? `${esc(g.product.name)} × ${g.quantity}` : "-";
  let warranty: TicketOrderSummary["warranty"] = null;
  if (order.status === OrderStatus.DELIVERED && order.deliveredAt && order.items[0]) {
    const until = addDays(order.deliveredAt, order.items[0].warrantyDaysSnapshot);
    warranty = { active: until.getTime() > Date.now(), untilDisplay: ensureUtc(until).toFormat("dd/LL/yyyy") };
  }
  return { orderCode: order.orderCode, statusBadge: statusBadge(order.status), productLine, warranty };
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
