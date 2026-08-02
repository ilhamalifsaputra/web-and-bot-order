/**
 * String enums — these mirror what SQLAlchemy actually persisted.
 *
 * IMPORTANT: SQLAlchemy `Enum(native_enum=False)` stores the enum MEMBER NAME
 * (uppercase), not the `.value`. Verified against the production DB:
 *   users.role        -> CUSTOMER | RESELLER | ADMIN
 *   users.language    -> EN | ID
 *   orders.status     -> PENDING_PAYMENT | PENDING_VERIFICATION | PAID |
 *                        DELIVERED | CANCELLED | REJECTED | REFUNDED
 *   stock_items.status-> AVAILABLE | RESERVED | SOLD | DEAD
 *   products.type     -> SHARED | PRIVATE
 *   vouchers.type     -> PERCENT | FIXED
 *   support_tickets   -> OPEN | REPLIED | CLOSED
 *   sender_type       -> USER | ADMIN
 *   notif event       -> ORDER_DELIVERED   (NOT the "order.delivered" value)
 *   notif status      -> PENDING | SENT | FAILED
 *
 * The string values below MUST equal those stored names byte-for-byte. This
 * corrects migrate.md §5.3, which wrongly assumed lowercase `.value`s.
 * Each enum gets a zod schema for validating input at the service boundary.
 */
import { z } from "zod";

export const UserRole = {
  CUSTOMER: "CUSTOMER",
  RESELLER: "RESELLER",
  ADMIN: "ADMIN",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const zUserRole = z.nativeEnum(UserRole);

export const Language = {
  EN: "EN",
  ID: "ID",
} as const;
export type Language = (typeof Language)[keyof typeof Language];
export const zLanguage = z.nativeEnum(Language);

/** Convert a stored Language ("EN"/"ID") to an i18n locale code ("en"/"id"). */
export const langCode = (l: string | null | undefined): string =>
  (l ?? "EN").toLowerCase();

export const ProductType = {
  SHARED: "SHARED",
  PRIVATE: "PRIVATE",
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];
export const zProductType = z.nativeEnum(ProductType);

/** How a Denomination (SKU) is fulfilled — stored on denominations.delivery_type.
 * Unlike the legacy SQLAlchemy enums above (which store uppercase member names),
 * these are lowercase values: this is a greenfield column we own, and the values
 * match the schema default `"auto"` and the admin/API JSON payloads directly. */
export const DeliveryType = {
  /** Existing behavior: pull credentials from stock, deliver instantly. Default. */
  AUTO: "auto",
  /** Admin hand-types & sends the account; no stock. PAID → PROCESSING → DELIVERED. */
  MANUAL: "manual",
  /** Manual, but the buyer fills custom fields at checkout BEFORE payment. */
  MANUAL_WITH_INFO: "manual_with_info",
} as const;
export type DeliveryType = (typeof DeliveryType)[keyof typeof DeliveryType];
export const zDeliveryType = z.nativeEnum(DeliveryType);

export const StockStatus = {
  AVAILABLE: "AVAILABLE",
  RESERVED: "RESERVED",
  SOLD: "SOLD",
  DEAD: "DEAD",
} as const;
export type StockStatus = (typeof StockStatus)[keyof typeof StockStatus];
export const zStockStatus = z.nativeEnum(StockStatus);

export const OrderStatus = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  // ── Bybit BSC on-chain rail ONLY — every other payment method never writes
  // these four values. PAYMENT_DETECTED/CONFIRMING/CONFIRMED are written by
  // the deposit poller + confirmation tracker (apps/order-bot/src/payments/
  // bybitBscDeposit.ts, bybitBscConfirmationTracker.ts); they are display-only
  // milestones on the way to the SAME PENDING_VERIFICATION → DELIVERED path
  // every other method already uses — they never skip or replace it.
  /** A still-confirming on-chain deposit has been matched to this order
   * (Bybit reports status 1/2, not yet its own "Success"). */
  PAYMENT_DETECTED: "PAYMENT_DETECTED",
  /** The block-explorer tracker has seen at least 1 confirmation. */
  CONFIRMING: "CONFIRMING",
  /** The tracker's confirmation count reached `requiredConfirmations` — a
   * display-grade milestone, NOT a delivery trigger (that stays gated on
   * Bybit's own status-3 report via deliverPaidBybitBscOrder). */
  CONFIRMED: "CONFIRMED",
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  PAID: "PAID",
  /** Payment confirmed for a MANUAL-delivery SKU (deliveryType manual /
   * manual_with_info): the order is awaiting hand-fulfilment by an admin (no
   * stock to pull). Reached only via settlePaidOrder's manual branch; the admin
   * fulfillment queue drains it to DELIVERED via fulfillManualOrder. Auto SKUs
   * never enter this state (they go PENDING_VERIFICATION → DELIVERED directly). */
  PROCESSING: "PROCESSING",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
  REFUNDED: "REFUNDED",
  // Set by the Binance Internal Transfer poller when a transfer's note matches
  // an order but the amount is short of the expected total (admin-reviewed,
  // never auto-delivered).
  UNDERPAID: "UNDERPAID",
  /** An automated pipeline failure discovered after PAYMENT_DETECTED with no
   * clean auto-resolution (tracker grace-period exhaustion, or a delivery
   * throw post-payment-confirmation) — needs admin attention. Distinct from
   * CANCELLED/REJECTED, which stay customer/admin-initiated only. */
  FAILED: "FAILED",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export const zOrderStatus = z.nativeEnum(OrderStatus);

/** Customer-facing label (an i18n key, not literal text) for a stored
 * OrderStatus. Several internal/automated states fold into the same coarse
 * label — e.g. PENDING_VERIFICATION/PAID/UNDERPAID all read as "Processing"
 * to a buyer, and CANCELLED/REJECTED/FAILED all read as "Failed". Storefront
 * and bot rendering should both go through this single mapping rather than
 * keeping their own parallel switch. */
export function customerStatusLabel(status: string): string {
  switch (status) {
    case OrderStatus.PENDING_PAYMENT:
      return "status.label.waiting_payment";
    case OrderStatus.PAYMENT_DETECTED:
      return "status.label.paid";
    case OrderStatus.CONFIRMING:
    case OrderStatus.CONFIRMED:
      return "status.label.confirming";
    case OrderStatus.PENDING_VERIFICATION:
    case OrderStatus.PAID:
    case OrderStatus.UNDERPAID:
    case OrderStatus.PROCESSING:
      return "status.label.processing";
    case OrderStatus.DELIVERED:
      return "status.label.delivered";
    case OrderStatus.CANCELLED:
    case OrderStatus.REJECTED:
    case OrderStatus.FAILED:
      return "status.label.failed";
    case OrderStatus.REFUNDED:
      return "status.label.refunded";
    default:
      return "status.label.processing";
  }
}

/** How the buyer pays. Stored on orders.payment_method. */
export const PaymentMethod = {
  /** Existing flow: Binance Pay ID + manual screenshot/TxID → admin approval. */
  BINANCE_PAY: "BINANCE_PAY",
  /** New flow: USDT to a Binance UID with the order ref as the note; auto-confirmed. */
  BINANCE_INTERNAL: "BINANCE_INTERNAL",
  /** USDT via Bybit's "Internal Transfer" (UID→UID, off-chain, instant);
   *  auto-confirmed by matching the unique deposit amount (internal transfers
   *  carry no memo). Bybit-account-to-Bybit-account only — a deposit cannot
   *  arrive here from another exchange. See BYBIT_BSC for the on-chain rail. */
  BYBIT: "BYBIT",
  /** USDT on-chain deposit to a Bybit-custodied BSC (BEP20) address;
   *  auto-confirmed by matching the unique deposit amount (BEP20 carries no
   *  memo). Slower than BYBIT (needs on-chain confirmation, ~1-2 min) but
   *  accepts a deposit from any BEP20 wallet/exchange, including a Binance
   *  withdrawal — unlike BYBIT's Internal Transfer. */
  BYBIT_BSC: "BYBIT_BSC",
  /** Rupiah gateway (QRIS/VA/e-wallet) — confirmed by webhook callback (plan.md §15.5). */
  TOKOPAY: "TOKOPAY",
  /** Indonesian QRIS/e-wallet aggregator (one admin-configured default channel,
   *  e.g. QRIS) — confirmed by webhook callback + reconcile poller, same shape
   *  as TOKOPAY. */
  PAYDISINI: "PAYDISINI",
  /** USDT crypto via NOWPayments hosted invoice (one admin-configured rail,
   *  e.g. USDT-TRC20) — confirmed by IPN webhook + reconcile poller, same shape
   *  as the other auto-confirm methods. */
  NOWPAYMENTS: "NOWPAYMENTS",
  /** Order fully paid by the buyer's wallet credit (IDR or USDT) — no
   *  external gateway involved. Created and delivered synchronously in one
   *  request (see packages/db/src/crud/wallet_checkout.ts); never sits in
   *  PENDING_PAYMENT long enough for a poller to see it. */
  WALLET: "WALLET",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const zPaymentMethod = z.nativeEnum(PaymentMethod);

/** Transaction currency on orders.currency — picked at PAY time (plan.md §15.2):
 * the catalog price is always central IDR; USDT is a derived, rounded figure. */
export const OrderCurrency = {
  IDR: "IDR",
  USDT: "USDT",
} as const;
export type OrderCurrency = (typeof OrderCurrency)[keyof typeof OrderCurrency];
export const zOrderCurrency = z.nativeEnum(OrderCurrency);

export const VoucherType = {
  PERCENT: "PERCENT",
  FIXED: "FIXED",
} as const;
export type VoucherType = (typeof VoucherType)[keyof typeof VoucherType];
export const zVoucherType = z.nativeEnum(VoucherType);

export const VoucherScope = {
  ALL: "ALL",
  SELECTED: "SELECTED",
} as const;
export type VoucherScope = (typeof VoucherScope)[keyof typeof VoucherScope];
export const zVoucherScope = z.nativeEnum(VoucherScope);

export const TicketStatus = {
  OPEN: "OPEN",
  REPLIED: "REPLIED",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];
export const zTicketStatus = z.nativeEnum(TicketStatus);

export const TicketPriority = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  URGENT: "URGENT",
} as const;
export type TicketPriority = (typeof TicketPriority)[keyof typeof TicketPriority];
export const zTicketPriority = z.nativeEnum(TicketPriority);

export const TicketCategory = {
  ORDER: "ORDER",
  PAYMENT: "PAYMENT",
  ACCOUNT: "ACCOUNT",
  PRODUCT: "PRODUCT",
  OTHER: "OTHER",
} as const;
export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory];
export const zTicketCategory = z.nativeEnum(TicketCategory);

export const SenderType = {
  USER: "USER",
  ADMIN: "ADMIN",
} as const;
export type SenderType = (typeof SenderType)[keyof typeof SenderType];
export const zSenderType = z.nativeEnum(SenderType);

export const NotificationEvent = {
  ORDER_DELIVERED: "ORDER_DELIVERED",
  // Admin DM (not a channel post): a payment-gateway webhook (TokoPay/
  // PayDisini/NOWPayments) delivered an order whose paid amount exceeded the
  // order total. payload carries `chat_id` (the admin's telegram id) plus
  // order_code/paid/expected/excess/currency so the dispatcher DMs each admin
  // directly instead of posting to PUBLIC_CHANNEL_ID.
  ADMIN_OVERPAID: "ADMIN_OVERPAID",
  // Admin DM (not a channel post): a one-time web-admin password-reset code.
  // payload carries `chat_id` (the admin's telegram id) so the dispatcher DMs
  // them directly instead of posting to PUBLIC_CHANNEL_ID.
  ADMIN_PW_RESET: "ADMIN_PW_RESET",
  // Buyer DM after a WEB order auto-delivers (TokoPay webhook path): "your
  // order is ready — view it on the site". Carries chat_id + order_code only,
  // NEVER credentials (the outbox table is visible in the admin /outbox panel).
  ORDER_DELIVERED_DM: "ORDER_DELIVERED_DM",
  // Buyer DM when a MANUAL-delivery order moves PAID → PROCESSING: "payment
  // received, your order is being prepared by hand, ~1×24h, we'll notify you".
  // Carries chat_id + order_code + buyer_language only.
  ORDER_PROCESSING_DM: "ORDER_PROCESSING_DM",
  // Buyer DM when an admin hand-fulfils a manual order (PROCESSING → DELIVERED):
  // sends the delivered content as a NEW message. Carries chat_id + order_code +
  // buyer_language only — the content is read LIVE from Order.deliveredContent at
  // dispatch time, never placed in the payload (same rule as ORDER_DELIVERED_DM).
  ORDER_MANUAL_DELIVERED_DM: "ORDER_MANUAL_DELIVERED_DM",
  // Admin DM (not a channel post): a Bybit BSC order's automated tracking
  // pipeline failed post-detection (tracker lookup-failure grace period
  // exhausted, or a delivery throw after Bybit reported the deposit
  // Success) — needs manual admin action. payload carries `chat_id` (the
  // admin's telegram id) plus order_code/reason, same fan-out-per-admin
  // shape as ADMIN_OVERPAID.
  ORDER_PIPELINE_FAILED: "ORDER_PIPELINE_FAILED",
  // Buyer DM broadcast to ALL non-banned customers with a linked Telegram
  // account, triggered when an admin adds stock to a product that has
  // broadcastOnRestock enabled. payload carries chat_id + product_name +
  // stock_count per recipient (one outbox row per customer).
  PRODUCT_RESTOCKED_BROADCAST: "PRODUCT_RESTOCKED_BROADCAST",
  // Buyer DM broadcast to ALL non-banned customers with a linked Telegram
  // account, triggered by the order-bot's announceStartedFlashSales job the
  // first minute a scheduled flash sale becomes live (its flashAnnouncedAt is
  // still null). payload carries chat_id + product_name + denomination_name +
  // discount_percent + old_price/new_price (already display-formatted) +
  // ends_at per recipient (one outbox row per customer).
  FLASH_SALE_BROADCAST: "FLASH_SALE_BROADCAST",
  // Admin DM (not a channel post): a paid order routed to the hand-fulfilment
  // queue (settlePaidOrder's MANUAL branch — a MANUAL/MANUAL_WITH_INFO SKU)
  // and is waiting on an admin to fulfil it by hand. payload carries
  // `chat_id` (the admin's telegram id) plus order_code/items/total/currency,
  // same fan-out-per-admin shape as ORDER_PIPELINE_FAILED.
  ADMIN_MANUAL_ORDER_QUEUED: "ADMIN_MANUAL_ORDER_QUEUED",
  // Channel post (not a DM) — same PUBLIC_CHANNEL_ID as ORDER_DELIVERED: a
  // single denomination's quantity within one order crossed the admin-set
  // "bulk_purchase_broadcast_threshold". payload carries product_name +
  // denomination_name + qty (escaped at render time, untrusted) plus the
  // admin-authored `template` string read from Settings at enqueue time
  // (trusted literal text, substituted with {qty}/{product}/{denomination}
  // tokens by the dispatcher). Enqueued from finalizeDeliverySideEffects,
  // gated the same way as ORDER_DELIVERED — skipped entirely when no channel
  // is configured, rather than left as a dead PENDING row.
  BULK_PURCHASE_BROADCAST: "BULK_PURCHASE_BROADCAST",
  // Admin DM (not a channel post): a payment-gateway webhook (TokoPay/
  // PayDisini/NOWPayments) confirmed payment for an order that had already
  // left PENDING_PAYMENT by the time the delivery transaction ran (M-10 fix,
  // backend audit 2026-07-31) — typically `autoCancelExpiredOrders` cancelled
  // it on a timer between the callback arriving and the transaction running.
  // Nothing else recovers this automatically: the reconcile pollers only fire
  // for orders still PENDING_PAYMENT, and reconcileFinances doesn't scan
  // ledger rows, so the payment needs a human to reconcile. payload carries
  // `chat_id` (the admin's telegram id) plus order_code/gateway/trx_id, same
  // fan-out-per-admin shape as ADMIN_OVERPAID.
  ADMIN_STALE_PAYMENT: "ADMIN_STALE_PAYMENT",
} as const;
export type NotificationEvent =
  (typeof NotificationEvent)[keyof typeof NotificationEvent];
export const zNotificationEvent = z.nativeEnum(NotificationEvent);

export const NotificationStatus = {
  PENDING: "PENDING",
  // Atomically claimed by a dispatcher right before a send attempt — the
  // crash-window double-send guard (Infra-2 fix). Reclaimable once stale.
  SENDING: "SENDING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;
export type NotificationStatus =
  (typeof NotificationStatus)[keyof typeof NotificationStatus];
export const zNotificationStatus = z.nativeEnum(NotificationStatus);

export const BroadcastStatus = {
  /** Composed and saved, but not yet queued — never picked up by
   *  claimNextDueBroadcast (which only matches PENDING). */
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  /** Atomically claimed by drainBroadcasts right before it starts sending —
   *  same crash-window guard as NotificationStatus.SENDING. Reclaimable/
   *  reapable once claimedAt is older than BROADCAST_STALE_CLAIM_MS. */
  SENDING: "SENDING",
  SENT: "SENT",
  CANCELLED: "CANCELLED",
  /** Either the drainer crashed mid-send (reaped by reapStaleBroadcasts) or
   *  the row referenced an unknown segment (failBroadcast). No automatic
   *  retry — see failureReason for why. */
  FAILED: "FAILED",
} as const;
export type BroadcastStatus =
  (typeof BroadcastStatus)[keyof typeof BroadcastStatus];
export const zBroadcastStatus = z.nativeEnum(BroadcastStatus);
