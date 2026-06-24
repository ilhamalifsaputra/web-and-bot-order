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
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  PAID: "PAID",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
  REFUNDED: "REFUNDED",
  // Set by the Binance Internal Transfer poller when a transfer's note matches
  // an order but the amount is short of the expected total (admin-reviewed,
  // never auto-delivered).
  UNDERPAID: "UNDERPAID",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export const zOrderStatus = z.nativeEnum(OrderStatus);

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

export const TicketStatus = {
  OPEN: "OPEN",
  REPLIED: "REPLIED",
  CLOSED: "CLOSED",
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];
export const zTicketStatus = z.nativeEnum(TicketStatus);

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
