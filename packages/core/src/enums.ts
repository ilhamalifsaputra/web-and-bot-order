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
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const zPaymentMethod = z.nativeEnum(PaymentMethod);

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
} as const;
export type NotificationEvent =
  (typeof NotificationEvent)[keyof typeof NotificationEvent];
export const zNotificationEvent = z.nativeEnum(NotificationEvent);

export const NotificationStatus = {
  PENDING: "PENDING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;
export type NotificationStatus =
  (typeof NotificationStatus)[keyof typeof NotificationStatus];
export const zNotificationStatus = z.nativeEnum(NotificationStatus);
