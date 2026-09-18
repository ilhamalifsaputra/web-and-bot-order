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

/**
 * SupportTicket.status. Trustance Phase C Task 1 expanded this from
 * `OPEN|REPLIED|RESOLVED|CLOSED` to also carry `WAITING_ADMIN`/
 * `WAITING_CUSTOMER` — a more explicit vocabulary for "whose turn it is to
 * respond" than the original OPEN/REPLIED pair (which conflated "brand new,
 * nobody has looked at it" and "customer replied, waiting on admin again"
 * into the same OPEN value).
 *
 * ## Task 1 FIX (post-review): wired and resolved
 *
 * The original Task 1 commit shipped `WAITING_ADMIN`/`WAITING_CUSTOMER`
 * unreachable by any real code path, with target lists in
 * `TICKET_LEGAL_TRANSITIONS` byte-for-byte identical to `OPEN`'s/`REPLIED`'s
 * — two exactly-synonymous pairs (task-scoped review Findings 1 and 2). A
 * follow-up fix wired `addTicketMessage` (packages/db/src/crud/support.ts —
 * the single choke point for every real reply in bot/web-admin/storefront)
 * to actually produce them, and resolved the redundancy:
 *
 *  - `OPEN` is KEPT — narrowed to mean "genuinely new, zero real messages
 *    yet" (written only by `createTicket` and the reopen functions). A
 *    customer's first follow-up now moves the ticket to `WAITING_ADMIN`
 *    instead of re-asserting `OPEN`.
 *  - `REPLIED` is KEPT in the enum/schema (existing `String` column, never
 *    rewrites historical rows — see this file's header comment) but RETIRED
 *    as a normal write target: `addTicketMessage`'s ADMIN branch and
 *    `replyToTicket` now write `WAITING_CUSTOMER` instead, since the review
 *    confirmed the two meant exactly the same thing. Every read-side
 *    consumer that used to check `REPLIED` alone (`listStaleRepliedTickets`,
 *    `getTicketStats`, `isTicketOverdue`/`buildTicketConditions`'s overdue
 *    predicate, bot keyboards/handlers, web-admin badges/filters/
 *    resolve-reopen visibility) was updated to match `WAITING_CUSTOMER`
 *    ALONGSIDE `REPLIED`, not instead of it.
 *  - `WAITING_ADMIN`/`WAITING_CUSTOMER` are now genuinely differentiated
 *    from `OPEN`/`REPLIED` (Finding 2), not just renamed: see
 *    `TICKET_LEGAL_TRANSITIONS`'s doc comment (support.ts) for the exact
 *    transition-table shape and why each new edge exists.
 *
 * This mirrors an established pattern already in this file — see
 * `OrderStatus.PARTIALLY_DELIVERED` and `OrderItemStatus`'s own "shadow, not
 * yet a source of truth" doc comments below, except this pair has since
 * graduated from shadow to live.
 */
export const TicketStatus = {
  OPEN: "OPEN",
  /** Retired as a normal write target (see this const's doc comment) —
   * `WAITING_CUSTOMER` is now written instead. Kept for historical rows and
   * one deliberate carve-out (`addTicketMessage`'s ADMIN branch replying to
   * an already-RESOLVED/CLOSED ticket — see that function's own comment). */
  REPLIED: "REPLIED",
  /** Ticket needs admin attention — a customer reply (after the ticket's
   * first-ever message) moves it here via `addTicketMessage` ->
   * `transitionTicketStatus`. See this const's doc comment. */
  WAITING_ADMIN: "WAITING_ADMIN",
  /** An admin has responded and the ticket is waiting on the customer's next
   * message — the live replacement for `REPLIED`, written by
   * `addTicketMessage`'s ADMIN branch and `replyToTicket`. See this const's
   * doc comment. */
  WAITING_CUSTOMER: "WAITING_CUSTOMER",
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

/** SupportTicket.category — admin-set triage field, null until classified
 * (`classifyTicket`). Trustance Phase C Task 1 added `DELIVERY`/
 * `GAME_TOPUP`/`REFUND`/`TECHNICAL` alongside the original 5 values for
 * finer-grained triage; existing rows keep whatever category (or null) they
 * already had — this is a plain `String` column, not a native Postgres enum
 * (see this file's header comment), so widening this const object needs no
 * migration and cannot itself invalidate a stored value. */
export const TicketCategory = {
  ORDER: "ORDER",
  PAYMENT: "PAYMENT",
  ACCOUNT: "ACCOUNT",
  PRODUCT: "PRODUCT",
  OTHER: "OTHER",
  /** Order paid but the item didn't arrive / arrived wrong. */
  DELIVERY: "DELIVERY",
  /** Game top-up specific issue (wrong game id/server, top-up didn't land in
   * the game account) — narrower than the general `PRODUCT`/`ORDER`. */
  GAME_TOPUP: "GAME_TOPUP",
  /** Ticket is about a refund request/status, distinct from a general
   * `PAYMENT` question. */
  REFUND: "REFUND",
  /** Bot/site bug reports, login issues, etc. — not about a specific order. */
  TECHNICAL: "TECHNICAL",
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
  // Admin DM (not a channel post): the hourly market-rate refresh
  // (`refreshUsdIdrRate`, scheduled by `scheduleFxRefresh`) fetched a
  // USD→IDR rate that failed `validateUsdIdrRate`'s sanity band — outside
  // `fx_rate_min`/`fx_rate_max`, or more than `fx_rate_max_delta_pct` away
  // from the rate already saved (M13 / audit P0-3). The saved rate and its
  // freshness stamp were left exactly as they were, so nothing mispriced;
  // this DM exists because that refusal is otherwise silent and the NEXT
  // hourly tick would refuse the same garbage again, forever, while the saved
  // rate quietly aged out. Same "malformed upstream response, circuit breaker
  // held, a human must check the source" category as
  // ADMIN_DIGIFLAZZ_RESYNC_ABORTED above. payload carries `chat_id` plus
  // reason/market/rate/saved (+ the reason's own figures: min, max,
  // last_known, delta_pct, max_delta_pct) and consecutive_failures — plain
  // money figures only, never a URL or credential. NOT order-scoped
  // (orderId: null): no order is involved, the rate is shop-wide.
  ADMIN_FX_RATE_REJECTED: "ADMIN_FX_RATE_REJECTED",
  // Admin DM (not a channel post): the saved `usd_idr_rate` has not been
  // confirmed against the market for longer than `fx_rate_max_age_hours`
  // (default 48h), so `getUsdIdrRate` now reports no rate at all and the
  // WHOLE USDT rail is hidden shop-wide — checkout stops offering it, USDT
  // prices stop being shown (M13 / audit P0-3). Deliberately a DIFFERENT
  // event from ADMIN_FX_RATE_REJECTED above even though the two often share a
  // root cause: the remedy is different (there, the rate SOURCE is suspect;
  // here, the shop is already losing USDT sales and the fix is to refresh or
  // re-enter a rate), and one alert must not be mistaken for the other.
  // Enqueued at most ONCE per staleness episode, keyed off the stamp it is
  // complaining about (`fx_stale_alerted_for`) — an hourly cron would
  // otherwise DM every admin 24 times a day for as long as nobody looked.
  // payload carries `chat_id` plus confirmed_at/age_hours/max_age_hours.
  // NOT order-scoped (orderId: null).
  ADMIN_FX_RATE_STALE: "ADMIN_FX_RATE_STALE",
  // Admin/support-group DM (fan-out — one row per resolved target, same
  // per-recipient shape as ADMIN_MANUAL_ORDER_QUEUED/ADMIN_STALE_PAYMENT):
  // forwards a newly-opened support ticket for triage. Enqueued from the
  // bot's own ticket-creation flow (conversations/support.ts) — the
  // storefront's ticket-creation path has no Telegram equivalent, it only
  // triggers OWNER_EMAIL_NEW_TICKET. Targets are `config.SUPPORT_GROUP_ID`
  // when set, else every resolved admin id (`resolveAdminIds`) — the same
  // fallback the pre-outbox direct send used. payload carries `chat_id` plus
  // ticket_id/from_user_id/from_username/message/photo_file_ids (Telegram
  // file ids only, never binary — the dispatcher re-sends them via
  // sendMediaGroup right after the text). NOT order-scoped (orderId: null)
  // — tickets have no order.
  ADMIN_NEW_TICKET: "ADMIN_NEW_TICKET",
  // Buyer DM (not a channel post): an admin replied to the buyer's support
  // ticket (conversations/admin.ts's ticketReplyConversation). Always
  // rendered in English — mirrors the pre-outbox direct send, which
  // hardcoded language "en" rather than the buyer's own stored language
  // (unlike TICKET_CLOSED_DM below, which does use it); preserved exactly
  // as-is, not a bug this event fixes. payload carries `chat_id` plus
  // ticket_id and the admin's reply text, NOT order-scoped (orderId: null).
  TICKET_REPLY_DM: "TICKET_REPLY_DM",
  // Buyer DM (not a channel post): an admin closed the buyer's support
  // ticket from the bot's admin panel (handlers/admin.ts's
  // closeTicketAdmin). Rendered in the buyer's own stored language
  // (payload.buyer_language), unlike TICKET_REPLY_DM above. payload carries
  // `chat_id` plus ticket_id and buyer_language, NOT order-scoped
  // (orderId: null).
  TICKET_CLOSED_DM: "TICKET_CLOSED_DM",
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
  // Terminal, never retried: a permanently invalid row (malformed payload,
  // missing template, missing chat_id, etc.) that failed on its one and only
  // eligible attempt (markNotificationFailed's maxAttempts <= 1 call sites).
  // Retrying would never fix these — they're a data/config problem, not a
  // transient delivery problem.
  FAILED: "FAILED",
  // Terminal: a row that WAS genuinely retried with exponential backoff
  // (markNotificationFailed's maxAttempts > 1 call sites, real
  // NOTIF_MAX_ATTEMPTS) and still exhausted every attempt. Distinct from
  // FAILED so operators can page on "retried to the ceiling, still failing"
  // without the metric being drowned out by one-shot invalid-data failures.
  DEAD_LETTER: "DEAD_LETTER",
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

/**
 * LedgerAccount.type (Financial Ledger M1) — the accounting classification of
 * a chart-of-accounts row, which is what decides whether a DEBIT to that
 * account increases or decreases its real-world balance. String, not a native
 * Prisma enum, matching every other classification column in this schema.
 *
 * ASSET/EXPENSE accounts increase on DEBIT; LIABILITY/REVENUE/EQUITY accounts
 * increase on CREDIT. CLEARING is meant as a normal-balance-agnostic transit
 * classification for money that has left the buyer but not yet landed in
 * `cash.*` — but the actual chart of accounts (`ledgerAccounts.ts`'s own doc
 * comment explains this in full) deliberately types NEITHER real clearing
 * account as CLEARING: `provider_clearing.*` is ASSET and `refund_clearing.*`
 * is LIABILITY, specifically because a trial balance can only close if each
 * side is classified by its actual normal balance, and CLEARING would force a
 * report to guess a sign. This value is therefore currently unused by any
 * seeded account — read `ledgerAccounts.ts` before adding a new account typed
 * CLEARING, since the chart's own reasoning argues against it in most cases.
 */
export const LedgerAccountType = {
  ASSET: "ASSET",
  LIABILITY: "LIABILITY",
  REVENUE: "REVENUE",
  EXPENSE: "EXPENSE",
  CLEARING: "CLEARING",
  EQUITY: "EQUITY",
} as const;
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];
export const zLedgerAccountType = z.nativeEnum(LedgerAccountType);

/**
 * LedgerEntry.direction (Financial Ledger M1) — which side of the
 * double-entry a single ledger line sits on. `LedgerEntry.amount` is ALWAYS
 * stored positive; this column carries the sign. A balanced
 * FinancialTransaction's DEBIT entries and CREDIT entries sum to the same
 * total per currency, which is the invariant `postFinancialTransaction`
 * (packages/db/src/crud/ledger.ts, since M2) enforces before the first INSERT.
 */
export const LedgerDirection = {
  DEBIT: "DEBIT",
  CREDIT: "CREDIT",
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];
export const zLedgerDirection = z.nativeEnum(LedgerDirection);

/**
 * FinancialTransaction.type (Financial Ledger M1) — what real-world event a
 * balanced group of LedgerEntry rows records. String, not a native Prisma
 * enum, matching every other lifecycle/classification column in this schema.
 *
 * REVERSAL is the only value that is about the ledger itself rather than
 * about money moving: this ledger is append-only, so a mis-posted
 * transaction is never edited or deleted — it is cancelled by posting a
 * REVERSAL whose entries mirror the original's with the directions flipped,
 * linked back through `FinancialTransaction.reversalOfId`. ADJUSTMENT, by
 * contrast, is a deliberate human correction of the books (a write-off, an
 * opening balance), not a fix for a bad posting.
 */
export const FinancialTransactionType = {
  ORDER_PAYMENT: "ORDER_PAYMENT",
  WALLET_DEPOSIT: "WALLET_DEPOSIT",
  WALLET_WITHDRAWAL: "WALLET_WITHDRAWAL",
  REFUND: "REFUND",
  REVERSAL: "REVERSAL",
  ADJUSTMENT: "ADJUSTMENT",
  FEE: "FEE",
  SETTLEMENT: "SETTLEMENT",
} as const;
export type FinancialTransactionType =
  (typeof FinancialTransactionType)[keyof typeof FinancialTransactionType];
export const zFinancialTransactionType = z.nativeEnum(FinancialTransactionType);

/**
 * RefundExecution.method (Financial Ledger M1) — how an approved Refund is
 * actually paid back to the buyer. WALLET credits the buyer's in-DB balance
 * (`User.walletBalance`/`walletBalanceUsdt`); MANUAL_TRANSFER is an admin
 * sending money out of band (bank transfer, gateway refund done by hand),
 * evidenced by `RefundExecution.reference`/`proofFileId`.
 *
 * This is deliberately separate from `Refund.status`: a Refund reaching
 * COMPLETED is record-keeping only and triggers no payout (see
 * Refund.status's own doc comment in prisma/schema.prisma), whereas a
 * RefundExecution row IS the payout attempt. `executeRefund`
 * (packages/db/src/crud/refunds.ts) is what carries one out and writes the row.
 */
export const RefundExecutionMethod = {
  WALLET: "WALLET",
  MANUAL_TRANSFER: "MANUAL_TRANSFER",
} as const;
export type RefundExecutionMethod =
  (typeof RefundExecutionMethod)[keyof typeof RefundExecutionMethod];
export const zRefundExecutionMethod = z.nativeEnum(RefundExecutionMethod);

/**
 * RefundExecution.status (Financial Ledger M1) — the lifecycle of one payout
 * attempt. PENDING -> COMPLETED | FAILED, both terminal. A FAILED execution
 * does not reopen its parent Refund; it records that this particular attempt
 * did not land, leaving an admin free to add another RefundExecution row for
 * the same Refund (which is why RefundExecution is a one-to-many child of
 * Refund rather than a single set of columns on Refund itself).
 */
export const RefundExecutionStatus = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type RefundExecutionStatus =
  (typeof RefundExecutionStatus)[keyof typeof RefundExecutionStatus];
export const zRefundExecutionStatus = z.nativeEnum(RefundExecutionStatus);

/**
 * Settlement.status (Financial Ledger M1) — how far an admin has got in
 * reconciling one payout batch from a payment provider against this shop's
 * own Payment rows. RECORDED is the raw manual entry ("the provider says it
 * paid us this"); RECONCILED means its SettlementTransaction children have
 * been matched to real payments and the totals agree; DISPUTED flags a batch
 * whose totals do not agree and that is being chased with the provider.
 * Manual entry is the only path in this milestone — no provider settlement
 * API is wired up.
 */
export const SettlementStatus = {
  RECORDED: "RECORDED",
  RECONCILED: "RECONCILED",
  DISPUTED: "DISPUTED",
} as const;
export type SettlementStatus = (typeof SettlementStatus)[keyof typeof SettlementStatus];
export const zSettlementStatus = z.nativeEnum(SettlementStatus);

/**
 * `LedgerReconciliationFinding.type` (Financial Ledger M5) — what kind of drift
 * `reconcileLedger` (packages/db/src/crud/reconcileLedger.ts) found between the
 * shop's operational rows (Order/Payment/User wallet balances/RefundExecution)
 * and the double-entry ledger that is supposed to describe them.
 *
 * Every value names a comparison between two real sets of rows, never a
 * heuristic — the reconciliation reports only discrepancies it can point at:
 *
 * - LEDGER_POSTING_MISSING — real money moved (an order settled, a top-up was
 *   credited, a refund was paid out) but no `FinancialTransaction` exists under
 *   the idempotency key that event derives. The most serious class: the books
 *   are silently understating what happened.
 * - WALLET_LEDGER_DRIFT — the sum of every `User.walletBalance` (or
 *   `walletBalanceUsdt`) disagrees with the `wallet_liability.<ccy>` control
 *   account that exists to mirror it. The control-account invariant the whole
 *   wallet sub-ledger rests on.
 * - DUPLICATE_PROVIDER_TRANSACTION — two `Payment` rows share one
 *   `(method, providerTransactionId)` pair. The schema's own
 *   `@@unique([method, providerTransactionId])` already forbids this, so a hit
 *   means something wrote around the Prisma client (a manual edit, a migration
 *   inconsistency) — a defensive read, expected to find nothing.
 * - REFUND_AMOUNT_MISMATCH — a `RefundExecution.amount` disagrees with the
 *   amount its own posted `FinancialTransaction` recorded, i.e. the buyer was
 *   paid one figure and the books say another.
 */
export const ReconciliationFindingType = {
  LEDGER_POSTING_MISSING: "LEDGER_POSTING_MISSING",
  WALLET_LEDGER_DRIFT: "WALLET_LEDGER_DRIFT",
  DUPLICATE_PROVIDER_TRANSACTION: "DUPLICATE_PROVIDER_TRANSACTION",
  REFUND_AMOUNT_MISMATCH: "REFUND_AMOUNT_MISMATCH",
} as const;
export type ReconciliationFindingType =
  (typeof ReconciliationFindingType)[keyof typeof ReconciliationFindingType];
export const zReconciliationFindingType = z.nativeEnum(ReconciliationFindingType);

/**
 * `LedgerReconciliationFinding.severity` (Financial Ledger M5) — how loudly one
 * finding should be escalated.
 *
 * WARNING is drift worth understanding but consistent with money being correct;
 * CRITICAL means the books and the money may genuinely disagree, which is the
 * class an admin has to act on. Every check `reconcileLedger` ships with today
 * reports CRITICAL — each of them compares two records of the SAME money, so
 * any disagreement means one of the two is wrong. WARNING exists for the
 * softer checks later milestones will add (an unsettled clearing balance, a
 * provider fee that drifted within tolerance) rather than being reserved
 * speculatively: a severity field with one possible value would not be one.
 */
export const ReconciliationSeverity = {
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
} as const;
export type ReconciliationSeverity =
  (typeof ReconciliationSeverity)[keyof typeof ReconciliationSeverity];
export const zReconciliationSeverity = z.nativeEnum(ReconciliationSeverity);

/**
 * `StockReplacement.status` (Financial Ledger M18) — where a "the credential
 * you delivered me is bad" complaint has got to. String, not a native Prisma
 * enum, matching every other lifecycle-status column in this schema
 * (`Order.status`, `Refund.status`, `Payment.status`).
 *
 * - REQUESTED — an admin has recorded the complaint against one purchased unit.
 *   The opening state; `StockReplacement.status`'s column default.
 * - AWAITING_STOCK — the complaint is accepted but there is no AVAILABLE
 *   credential for that SKU to hand over yet. Distinct from REQUESTED because
 *   it says the hold-up is supply, not triage, which is what makes it the
 *   status a restock should be able to unblock.
 * - COMPLETED — a replacement credential was issued
 *   (`replacementStockItemId` is set).
 * - REFUNDED_INSTEAD — no replacement was issued and the buyer got their money
 *   back (`refundId` is set). A distinct terminal value rather than a flag on
 *   COMPLETED: "the buyer holds a working account" and "the buyer holds their
 *   money" are different outcomes, and only one of them consumed stock.
 * - CANCELLED — withdrawn before resolution (the buyer recovered access, the
 *   complaint turned out to be user error).
 * - FAILED — the shop could neither replace nor refund. Kept separate from
 *   CANCELLED so an unresolved complaint can never be filed away as a
 *   deliberate withdrawal.
 *
 * COMPLETED, REFUNDED_INSTEAD, CANCELLED and FAILED are all TERMINAL: nothing
 * transitions out of them, and each is what sets `resolvedAt`. REQUESTED and
 * AWAITING_STOCK are the only non-terminal values. The transition table itself
 * (a `LEGAL_TRANSITIONS`-shaped map alongside `REFUND_LEGAL_TRANSITIONS` /
 * `PAYMENT_LEGAL_TRANSITIONS`) belongs with the `replaceStockItem` service in
 * M19 and deliberately does not exist yet — this milestone is schema only.
 */
export const StockReplacementStatus = {
  REQUESTED: "REQUESTED",
  AWAITING_STOCK: "AWAITING_STOCK",
  COMPLETED: "COMPLETED",
  REFUNDED_INSTEAD: "REFUNDED_INSTEAD",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;
export type StockReplacementStatus =
  (typeof StockReplacementStatus)[keyof typeof StockReplacementStatus];
export const zStockReplacementStatus = z.nativeEnum(StockReplacementStatus);

/**
 * The four terminal `StockReplacementStatus` values — the ones that set
 * `StockReplacement.resolvedAt` and that nothing transitions out of. Exported
 * as data (not re-derived by each caller) so M19's transition table and any
 * "still open" admin query agree on one list, the same way
 * `IN_FLIGHT_ORDER_ITEM_STATUSES` serves `deriveOrderStatusFromItems`.
 */
export const TERMINAL_STOCK_REPLACEMENT_STATUSES: readonly StockReplacementStatus[] = [
  StockReplacementStatus.COMPLETED,
  StockReplacementStatus.REFUNDED_INSTEAD,
  StockReplacementStatus.CANCELLED,
  StockReplacementStatus.FAILED,
] as const;
