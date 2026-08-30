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
  /** Some of the order's items were delivered and the rest ended FAILED or
   * CANCELLED, with nothing still in flight — derived by
   * `recomputeOrderStatus` (packages/db/src/crud/orders.ts) from the set of
   * `OrderItem.status` values.
   *
   * NOTHING PRODUCES THIS TODAY, on purpose. Trustance Phase 1 Task 3 added
   * the per-item status machinery as a provable no-op shadow of the existing
   * order-level outcome: every order the current code paths can create is
   * homogeneous (the cart composition rule in @app/core/cartComposition
   * forbids mixing), so every item in an order always shares one status and
   * `recomputeOrderStatus` always derives the status the order already has.
   * `orderItemStatus.test.ts` asserts that unreachability directly.
   *
   * It exists because a later plan will loosen cart mixing so a MANUAL_ACCOUNT
   * line and an INSTANT line can resolve independently — at which point a
   * genuinely split order becomes representable. That plan also owns the
   * Refund/IN_DOUBT work a paid-but-failed line needs; do not start producing
   * this value before that resolution path exists, or a buyer ends up with a
   * partially-delivered order and nowhere to take the difference. */
  PARTIALLY_DELIVERED: "PARTIALLY_DELIVERED",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export const zOrderStatus = z.nativeEnum(OrderStatus);

/**
 * Per-line fulfilment state — stored on `order_items.status` (Trustance
 * Phase 1, Task 3). String enum, uppercase member names, matching every other
 * legacy-shaped enum in this file rather than DeliveryType's lowercase values:
 * this mirrors `Order.status`, which it shadows, so the two read alike in the
 * DB and in a log line.
 *
 * ## It is a SHADOW today, not a source of truth
 *
 * Nothing branches on this column. `settlePaidOrder` still computes one
 * order-wide `isManual` boolean and takes the same whole-order branch it always
 * did; the item statuses are written alongside that branch's own order-level
 * status write, in the same transaction, so they always agree with it and with
 * each other. Every order the current code paths can create is homogeneous, so
 * a split set of item statuses is not reachable — `orderItemStatus.test.ts`
 * proves that for every order shape (all-AUTO multi-item, single manual, and
 * top-up). Loosening that is a later plan's job.
 *
 * ## Deliberately absent
 *
 * `IN_DOUBT` and `REFUNDED` are NOT here. They belong to the Refund domain,
 * which this plan defers — adding the names without the resolution path behind
 * them would invite a call site to move an item into a state nothing can move
 * it out of.
 *
 * ## Null means "row predates this column"
 *
 * The column is nullable with NO default, for the same reason
 * `OrderItem.deliveryTypeSnapshot` is (see its comment in schema.prisma): this
 * repo deploys schema with `prisma db push`, which adds the column but never
 * backfills it. A `NOT NULL DEFAULT 'PENDING'` would silently relabel every
 * historical DELIVERED order's items as PENDING at the deploy boundary.
 * Consumers must treat null as "unknown, derive nothing" — which is exactly
 * what `deriveOrderStatusFromItems` does.
 */
export const OrderItemStatus = {
  /** Created, not yet paid for. The state every new OrderItem starts in. */
  PENDING: "PENDING",
  /** Reserved for the future per-item info flow: this line needs buyer input
   * before it can be fulfilled. Not written by any current code path — today
   * `manual_with_info` answers are collected order-wide BEFORE payment, into
   * `Order.customerData`. */
  WAITING_FOR_INFO: "WAITING_FOR_INFO",
  /** Reserved, pairs with WAITING_FOR_INFO. Not written today. */
  INFO_SUBMITTED: "INFO_SUBMITTED",
  /** Paid, and waiting on an admin to hand-fulfil it. The MANUAL branch of
   * `settlePaidOrder` sets this — the item-level shadow of the order reaching
   * `OrderStatus.PROCESSING`. */
  QUEUED: "QUEUED",
  /** Reserved: fulfilment is actively under way for this line (e.g. a supplier
   * dispatch is in flight). Not written today — the Digiflazz rail tracks its
   * own progress on the Order, not per item. */
  PROCESSING: "PROCESSING",
  /** Fulfilled. Set by `approveOrder`'s atomic claim (the AUTO path) and by
   * `fulfillManualOrder` (the hand-fulfilment path). */
  DELIVERED: "DELIVERED",
  /** Fulfilment failed for this line. Reserved — no current path writes it,
   * because a whole-order failure is recorded on the Order today. */
  FAILED: "FAILED",
  /** This line was cancelled before fulfilment. Reserved, same reason. */
  CANCELLED: "CANCELLED",
} as const;
export type OrderItemStatus = (typeof OrderItemStatus)[keyof typeof OrderItemStatus];
export const zOrderItemStatus = z.nativeEnum(OrderItemStatus);

/** Item states that mean "this line has not reached an outcome yet". An order
 * with any of these still keeps whatever in-flight status it already has —
 * `deriveOrderStatusFromItems` refuses to derive a terminal status while one
 * is present. */
export const IN_FLIGHT_ORDER_ITEM_STATUSES: readonly OrderItemStatus[] = [
  OrderItemStatus.PENDING,
  OrderItemStatus.WAITING_FOR_INFO,
  OrderItemStatus.INFO_SUBMITTED,
  OrderItemStatus.QUEUED,
  OrderItemStatus.PROCESSING,
];

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
    // Gets its own label rather than folding into "Delivered": the whole point
    // of the state is that part of the order did NOT arrive, and a buyer told
    // "Delivered" would have no reason to open a ticket. Unreachable today —
    // see OrderStatus.PARTIALLY_DELIVERED.
    case OrderStatus.PARTIALLY_DELIVERED:
      return "status.label.partially_delivered";
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

export const OrderKind = { PRODUCT: "PRODUCT", WALLET_TOPUP: "WALLET_TOPUP" } as const;
export type OrderKind = (typeof OrderKind)[keyof typeof OrderKind];
export const zOrderKind = z.nativeEnum(OrderKind);

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

/** Customer-facing top-level grouping on Category.group — admin-set, null
 * until classified. Drives the bot's "🛍 Products" entry point: exactly two
 * buckets shown before any category/product. */
export const CategoryGroup = {
  GAME_TOPUP: "GAME_TOPUP",
  PREMIUM_APPS: "PREMIUM_APPS",
} as const;
export type CategoryGroup = (typeof CategoryGroup)[keyof typeof CategoryGroup];
export const zCategoryGroup = z.nativeEnum(CategoryGroup);

/** Review reply-workflow state — orthogonal to `hidden` (visibility) on
 * reviews.status. PENDING_REPLY | REPLIED | CLOSED (spec §11). */
export const ReviewStatus = {
  PENDING_REPLY: "PENDING_REPLY",
  REPLIED: "REPLIED",
  CLOSED: "CLOSED",
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];
export const zReviewStatus = z.nativeEnum(ReviewStatus);

/** Review provenance — reviews.source. Every Phase-A row is CUSTOMER;
 * SYSTEM_AUTO is reserved for the deferred auto-review job (Phase B). */
export const ReviewSource = {
  CUSTOMER: "CUSTOMER",
  SYSTEM_AUTO: "SYSTEM_AUTO",
} as const;
export type ReviewSource = (typeof ReviewSource)[keyof typeof ReviewSource];
export const zReviewSource = z.nativeEnum(ReviewSource);

/** Review sentiment — reviews.sentiment. Computed once at creation time and
 * persisted (not derived on read), so it stays filterable/aggregatable. */
export const ReviewSentiment = {
  POSITIVE: "POSITIVE",
  NEUTRAL: "NEUTRAL",
  NEGATIVE: "NEGATIVE",
} as const;
export type ReviewSentiment =
  (typeof ReviewSentiment)[keyof typeof ReviewSentiment];
export const zReviewSentiment = z.nativeEnum(ReviewSentiment);

export const SenderType = {
  USER: "USER",
  ADMIN: "ADMIN",
} as const;
export type SenderType = (typeof SenderType)[keyof typeof SenderType];
export const zSenderType = z.nativeEnum(SenderType);

export const NotificationEvent = {
  ORDER_DELIVERED: "ORDER_DELIVERED",
  // Admin DM (not a channel post): a payment path delivered an order whose
  // paid amount exceeded the order total. Enqueued by all six rails — the
  // gateway webhooks (TokoPay/PayDisini/NOWPayments) and the amount-matched
  // deposit pollers (Binance Internal, Bybit Internal Transfer, Bybit BSC).
  // payload carries `chat_id` (the admin's telegram id) plus
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
  // Buyer DM: a wallet top-up settled and the buyer's balance was credited.
  // Enqueued from exactly ONE place for ALL SIX top-up rails —
  // `settleWalletTopup` (packages/db/src/crud/wallet_topup.ts), behind that
  // function's atomic claim, so the double-settlement no-op branch can never
  // reach it. This used to be split: the three webhook rails enqueued it
  // per-rail while the three poller rails (Binance Internal, Bybit, Bybit BSC)
  // DM'd the buyer directly from their own `onDelivered`. That split is what
  // let a QRIS top-up notify the buyer twice, so the direct sends were
  // deleted — no rail may send this itself, and no caller other than
  // `settleWalletTopup` may enqueue it. payload carries `chat_id` +
  // `order_code` + `amount`/`currency`/`new_balance` (all money as Decimal
  // `.toString()`), so the dispatcher needs no live DB read.
  WALLET_TOPUP_CREDITED_DM: "WALLET_TOPUP_CREDITED_DM",
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
  // Admin DM (not a channel post): the NOWPayments reconcile poller found an
  // order the gateway reports `finished`, but the response carried no
  // `payment_id` — and `payment_id` IS that rail's idempotency-ledger key, so
  // there is nothing to claim the delivery under. Task E4 made the poller
  // refuse to deliver in that case rather than invent a key its IPN webhook
  // could never collide with; this alert is Task E5's mitigation for the cost
  // of that refusal. Without it, an order whose IPN also never arrives simply
  // runs out its payment window and auto-cancels with the buyer's money paid,
  // and nobody is told. Carries a dedupe key per (order, admin) because the
  // poller re-hits this branch every cycle until the order expires — see
  // `enqueueAdminUnconfirmablePayment`. payload carries `chat_id` (the
  // admin's telegram id) plus order_code and gateway, same fan-out-per-admin
  // shape as ADMIN_STALE_PAYMENT above.
  ADMIN_UNCONFIRMABLE_PAYMENT: "ADMIN_UNCONFIRMABLE_PAYMENT",
  // EMAIL-channel event (channel=EMAIL, not a Telegram DM): the shop owner,
  // at the single `owner_email` address configured in Settings — receives
  // this when an AUTO-delivery order is paid (settlePaidOrder's AUTO branch,
  // beside approveOrder). payload carries `to` (the resolved owner address)
  // plus order_code/total/currency for the email body, NOT `chat_id`. Gated
  // by resolveOwnerEmailRecipient: the master toggle, the per-event toggle,
  // and a valid address must all be set, or nothing is enqueued.
  OWNER_EMAIL_ORDER_PAID: "OWNER_EMAIL_ORDER_PAID",
  // EMAIL-channel event (channel=EMAIL, not a Telegram DM): the shop owner
  // receives this when a paid order routes to the hand-fulfilment queue
  // (settlePaidOrder's MANUAL branch, beside enqueueManualOrderAdminAlert) —
  // same trigger as ADMIN_MANUAL_ORDER_QUEUED, but a distinct event so the
  // Telegram render() if-chain and the email renderer never need to handle
  // each other's payload shape. payload carries `to` plus
  // order_code/items/total/currency, NOT `chat_id`. Gated by
  // resolveOwnerEmailRecipient, same as OWNER_EMAIL_ORDER_PAID.
  OWNER_EMAIL_MANUAL_ORDER_QUEUED: "OWNER_EMAIL_MANUAL_ORDER_QUEUED",
  // EMAIL-channel event (channel=EMAIL, not a Telegram DM): the shop owner
  // receives this when a new SupportTicket is created — from either the
  // storefront (apiAccount.ts) or the bot (conversations/support.ts), both
  // routed through the single createTicket CRUD helper so no call site can
  // skip it. payload carries `to` plus ticket subject/category and the
  // opening message, NOT `chat_id`. Gated by resolveOwnerEmailRecipient.
  OWNER_EMAIL_NEW_TICKET: "OWNER_EMAIL_NEW_TICKET",
  // EMAIL-channel event (channel=EMAIL, not a Telegram DM): the shop owner
  // receives this when a customer (SenderType.USER, never ADMIN) replies to
  // an existing ticket via addTicketMessage — an admin's own reply must
  // never trigger this. payload carries `to` plus ticket subject and the
  // reply body, NOT `chat_id`. Gated by resolveOwnerEmailRecipient.
  OWNER_EMAIL_TICKET_REPLY: "OWNER_EMAIL_TICKET_REPLY",
  // EMAIL-channel event (channel=EMAIL, not a Telegram DM): the shop owner
  // receives this when a buyer's wallet top-up settles (settleWalletTopup,
  // inside the successful atomic PENDING_PAYMENT -> DELIVERED claim branch,
  // after adjustWallet) — the one call site all six top-up-capable rails
  // (TokoPay, PayDisini, NOWPayments, Binance Internal, Bybit, Bybit BSC)
  // funnel through, so this enqueues exactly once per settled top-up
  // regardless of which rail settled it. Distinct from
  // enqueueWalletTopupCreditedDm (a Telegram DM to the buyer, not the owner)
  // — the two never share a payload shape. payload carries `to` plus
  // order_code/customer_label/amount/currency/new_balance/payment_method/
  // transaction_id/topped_up_at, NOT `chat_id`. Gated by
  // resolveOwnerEmailRecipient, same as the other OWNER_EMAIL_* events.
  OWNER_EMAIL_WALLET_TOPUP: "OWNER_EMAIL_WALLET_TOPUP",
  // EMAIL-channel event (channel=EMAIL, not a Telegram DM) — and the ONLY
  // one whose recipient is the BUYER rather than the shop owner. Read that
  // sentence again before touching this entry: every OWNER_EMAIL_* event
  // above resolves its `to` from Settings via resolveOwnerEmailRecipient and
  // is gated behind a master toggle plus a per-event toggle. This one does
  // NEITHER, deliberately. Its `to` is the guest shopper's own `guestEmail`,
  // passed straight down from the call site as an argument, and there is no
  // owner toggle because telling a customer their order is finished is not a
  // courtesy the shop opts into — it is the order's completion receipt. Do
  // not "unify" this onto the owner-email path; doing so would make a
  // buyer's receipt vanish whenever the owner turned their own alerts off,
  // and would mail the ORDER to the shop owner's address.
  //
  // Enqueued from packages/db/src/crud/orders.ts at the two points an order
  // actually becomes ready — settlePaidOrder's AUTO branch and
  // fulfillManualOrder — both guarded on `user.isGuest && user.guestEmail`.
  // Two call sites, not one: a manual SKU never passes through the AUTO
  // branch, so a guest who bought one would otherwise get nothing.
  //
  // payload carries `to` plus order_code/items/subtotal/discount/total/
  // currency/warranty_days/order_url/track_url, NOT `chat_id`. It carries NO
  // credentials and no delivered content, ever: email is unencrypted, sits in
  // an inbox forever, and the payload itself is visible in the admin /outbox
  // panel. The buyer reads what they bought on the order page.
  BUYER_EMAIL_ORDER_READY: "BUYER_EMAIL_ORDER_READY",
  // Admin DM (not a channel post): the hourly Digiflazz catalog resync
  // (resyncDigiflazzCatalog) tripped its own blast-radius circuit breaker
  // and wrote nothing — more than 20% of the denominations it would have
  // repriced (out of at least 5 considered) would have moved by more than
  // 50% in one direction. That usually means the supplier's price-list
  // response is malformed (a field rename, a partial outage, the wrong
  // endpoint) rather than a genuine market-wide price swing (Task 10,
  // backend audit 2026-08-21 C-1, second half — closes the blast-radius gap
  // left after Task 9's per-row rejection). Nothing else catches this: the
  // next hourly tick would otherwise silently retry the same malformed data.
  // payload carries `chat_id` (the admin's telegram id) plus
  // sharp_changes/considered_rows (plain counts only, never a SKU/price
  // dump), same fan-out-per-admin shape as ADMIN_STALE_PAYMENT above.
  ADMIN_DIGIFLAZZ_RESYNC_ABORTED: "ADMIN_DIGIFLAZZ_RESYNC_ABORTED",
} as const;
export type NotificationEvent =
  (typeof NotificationEvent)[keyof typeof NotificationEvent];
export const zNotificationEvent = z.nativeEnum(NotificationEvent);

/** Transport for a NotificationOutbox row — notification_outbox.channel.
 * Explicit row data rather than inferred from the event name (see
 * NotificationEvent's OWNER_EMAIL_* entries and the dispatcher's
 * ADMIN_DM_EVENTS set, which only ever distinguished Telegram DM from
 * channel post). Defaults to TELEGRAM at the schema level. */
export const NotificationChannel = {
  TELEGRAM: "TELEGRAM",
  EMAIL: "EMAIL",
} as const;
export type NotificationChannel =
  (typeof NotificationChannel)[keyof typeof NotificationChannel];
export const zNotificationChannel = z.nativeEnum(NotificationChannel);

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

/**
 * Refund.status (Trustance Master Architecture Task 8a/8b). String, not a
 * native Prisma enum — matching every other lifecycle-status column in this
 * schema (Order.status, OrderItem.status, Denomination.deliveryType).
 *
 * The legal transition shape is PENDING -> PROCESSING -> COMPLETED | FAILED,
 * with CANCELLED reachable from PENDING or PROCESSING only — see
 * `REFUND_LEGAL_TRANSITIONS` (packages/db/src/crud/refunds.ts), which mirrors
 * `LEGAL_TRANSITIONS` in orderStatus.ts. COMPLETED/FAILED/CANCELLED are all
 * terminal: no code path transitions a Refund back out of any of them.
 */
export const RefundStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];
export const zRefundStatus = z.nativeEnum(RefundStatus);

/**
 * Payment.status (Trustance Phase A Task A2a) — a multi-attempt payment
 * ledger that coexists with (does not replace) the payment fields directly on
 * `Order` (`paymentMethod`, `paymentRef`, `binanceTxid`, `bybitTxid`, ...),
 * which stay the "current/latest attempt" cache the six existing payment-rail
 * webhook/poller handlers read directly. String, not a native Prisma enum,
 * matching every other lifecycle-status column in this schema (`Order.status`,
 * `Refund.status`, `OrderItem.status`).
 *
 * The legal transition shape is PENDING -> CONFIRMED | EXPIRED | FAILED, all
 * three terminal — see `PAYMENT_LEGAL_TRANSITIONS`
 * (packages/db/src/crud/payments.ts). Only PENDING -> EXPIRED
 * (`expirePaymentAttempt`) and PENDING -> CONFIRMED (`confirmPaymentAttempt`)
 * have a crud function today; PENDING -> FAILED is reserved in the shape for
 * a future caller (e.g. Task 3's webhook wiring reporting a declined/failed
 * gateway attempt) without needing to touch the transition table again.
 */
export const PaymentStatus = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];
export const zPaymentStatus = z.nativeEnum(PaymentStatus);

/**
 * Payment.expiryReason (Trustance Phase A Task A2a) — free-text-shaped but
 * constrained in practice to these three machine codes, set only when
 * `Payment.status` reaches EXPIRED (`expirePaymentAttempt`,
 * packages/db/src/crud/payments.ts). "RAIL_CHANGED" is written by the new
 * "change payment rail" entry point (apps/order-bot/src/handlers/
 * checkout.ts) when a buyer switches gateways on the SAME order instead of
 * abandoning it; "TIMEOUT" and "CANCELLED" are reserved for a future poller/
 * cancel-order caller to use the same column instead of inventing another.
 */
export const PaymentExpiryReason = {
  RAIL_CHANGED: "RAIL_CHANGED",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
} as const;
export type PaymentExpiryReason = (typeof PaymentExpiryReason)[keyof typeof PaymentExpiryReason];

/**
 * AdminTask.type (Trustance Master Architecture Task 9a, §38) — the five
 * manual-operation task kinds the admin task queue can hold. String, not a
 * native Prisma enum, matching every other lifecycle-status-adjacent column
 * in this schema.
 */
export const AdminTaskType = {
  /** A `manual_with_info`-adjacent flow needs the buyer to supply more
   * detail before the task can proceed. */
  REQUEST_CUSTOMER_INFO: "REQUEST_CUSTOMER_INFO",
  /** A paid order routed to hand-fulfilment (Denomination.deliveryType
   * manual/manual_with_info) needs an admin to type and send the content. */
  MANUAL_DELIVERY: "MANUAL_DELIVERY",
  /** A specific manual account needs to be picked/assigned to an order. */
  MANUAL_ACCOUNT_ASSIGNMENT: "MANUAL_ACCOUNT_ASSIGNMENT",
  /** A Digiflazz-routed top-up came back failed/ambiguous and needs admin
   * review (see OrderStatus.FAILED / the Digiflazz resync circuit breaker). */
  FAILED_TOPUP_REVIEW: "FAILED_TOPUP_REVIEW",
  /** A Refund record needs admin review/decision — see AdminTask.refundId. */
  REFUND_REVIEW: "REFUND_REVIEW",
} as const;
export type AdminTaskType = (typeof AdminTaskType)[keyof typeof AdminTaskType];
export const zAdminTaskType = z.nativeEnum(AdminTaskType);

/**
 * AdminTask.priority — same LOW/MEDIUM/HIGH/URGENT vocabulary as
 * `TicketPriority` (this schema's existing precedent for an admin-set
 * triage field), kept as its own named enum rather than re-exporting
 * TicketPriority so the AdminTask domain stays self-contained, matching how
 * OrderStatus/RefundStatus are separate enums despite overlapping shape.
 */
export const AdminTaskPriority = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  URGENT: "URGENT",
} as const;
export type AdminTaskPriority = (typeof AdminTaskPriority)[keyof typeof AdminTaskPriority];
export const zAdminTaskPriority = z.nativeEnum(AdminTaskPriority);

/**
 * AdminTask.status — the state machine driven by the four admin actions
 * §38 names (Assign / Start / Complete / Escalate):
 *
 *   PENDING --assign--> ASSIGNED --start--> IN_PROGRESS --complete--> COMPLETED
 *      |                    |                    |
 *      +---escalate---> ESCALATED <---escalate---+
 *                          | (assign)   | (start)   | (complete)
 *                          +-------------------------------------> ASSIGNED / IN_PROGRESS / COMPLETED
 *
 * PENDING is the only status with no assignee. ASSIGNED/IN_PROGRESS/
 * ESCALATED all carry a non-null `assignedTo` in practice (set by the
 * `assign` action) — not enforced at the schema level (see AdminTask.
 * assignedTo's own doc comment), the same "app-layer invariant, not a CHECK
 * constraint" pattern this schema already uses for RefundItem's sum
 * invariant. ESCALATED is deliberately NOT terminal: escalating hands a
 * task to a different/more senior admin, who can still re-assign, resume,
 * or complete it — see `ADMIN_TASK_LEGAL_TRANSITIONS`
 * (packages/db/src/crud/adminTasks.ts) for the exact edges. COMPLETED is
 * the only terminal status; there is no "cancelled"/"rejected" status for
 * an AdminTask today (unlike Refund/Order) because nothing in §38 or the
 * task description asked for one — closing that gap is future work if an
 * admin needs to explicitly drop a task rather than complete it.
 */
export const AdminTaskStatus = {
  PENDING: "PENDING",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  ESCALATED: "ESCALATED",
  COMPLETED: "COMPLETED",
} as const;
export type AdminTaskStatus = (typeof AdminTaskStatus)[keyof typeof AdminTaskStatus];
export const zAdminTaskStatus = z.nativeEnum(AdminTaskStatus);
