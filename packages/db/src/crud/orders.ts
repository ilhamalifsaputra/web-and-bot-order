/**
 * Orders domain — the heart of the money/stock logic. Port of the "Orders"
 * section of Python crud.py. Multi-step mutators (create/approve/reject/cancel)
 * MUST run inside a prisma.$transaction so the order, stock, wallet, voucher
 * and outbox changes land atomically.
 */
import { config } from "@app/core/config";
import {
  OrderKind,
  OrderStatus,
  ORDER_HOLD_RELEASED_STATUSES,
  OrderItemStatus,
  StockStatus,
  StockEventType,
  StockActorType,
  UserRole,
  DeliveryType,
  OrderCurrency,
  PaymentMethod,
  langCode,
  type CategoryGroup,
} from "@app/core/enums";
import { deriveOrderStatusFromItems } from "@app/core/orderItemStatus";
import { reconciledOrderMoneyRows } from "@app/core/orderMoneyRows";
import { parseAdditionalFields, validateCustomerData } from "@app/core/deliveryFields";
import { parseInputFields, inputConfigSnapshot } from "@app/core/playerInput";
import {
  quantizeMoney,
  generateOrderCode,
  computeUniqueCents,
  usdtFromIdr,
} from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { effectiveUnitPrice, type FlashFields } from "@app/core/flash";
import { bulkDiscountFor } from "@app/core/bulk";
import { utcStamp, addMinutes, addDays } from "@app/core/datetime";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { NotificationEvent } from "@app/core/enums";
import { publicChannelId } from "@app/core/runtime";
import {
  decryptStockCredentials,
  tryDecryptCredentials,
  encryptDeliveredContent,
  decryptDeliveredContent,
  tryDecryptDeliveredContent,
} from "@app/core/credentialCrypto";
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { assertServiceActive } from "./serviceAvailability";
import type { ServiceChannel } from "@app/core/services";
import { isUniqueViolation, isUniqueViolationOn } from "./_types";
import { getBulkPricingForDenomination } from "./catalog";
import {
  getVoucherByCode,
  applyVoucherToSubtotal,
  assertVoucherNotRedeemedByUser,
  computeEligibleAmounts,
  releaseVoucherUse,
  type EligibilityLine,
} from "./vouchers";
import { countAvailableStock, allocateOneAvailableStock } from "./stock";
import { recordStockEvent, type StockEventActor } from "./stockEvents";
import { adjustWallet, getUser } from "./users";
import { ACTIONABLE_LEDGER_OUTCOMES, cancelledOrderIdsWithMoneyReturned, consumeIncomingLedgerPayment } from "./reports";
import { clearCart, getCart, lockCartForCheckout } from "./cart";
import { getSetting } from "./settings";
import { maybePayReferralCommission } from "./referrals";
import {
  postOrderHoldReleasePosting,
  postOrderPaymentPosting,
  postOrderWalletCreditPosting,
} from "./ledgerPostings";
import {
  enqueueNotification,
  enqueueOrderProcessingDm,
  enqueueManualDeliveredDm,
  enqueueManualOrderAdminAlert,
  enqueueOwnerOrderPaidEmail,
  enqueueOwnerManualQueueEmail,
  enqueueBuyerOrderReadyEmail,
} from "./notifications";
import { logAdminAction } from "./audit";
import { transitionOrderStatus, tryTransitionOrderStatus } from "./orderStatus";

/**
 * Thrown by `createOrderDirect`/`createOrderFromCart` when the caller-supplied
 * `checkoutIntentId` collides with one already stamped on another `Order` row
 * — the atomic, DB-enforced counterpart to the bot's best-effort
 * `refuseDuplicateCheckout` check (apps/order-bot/src/handlers/checkout.ts):
 * two near-simultaneous "Buy Now" taps for the same checkout attempt race to
 * insert an `Order` with the same `checkoutIntentId`; the `orders.checkout_
 * intent_id` unique index lets exactly one INSERT win, and the loser's
 * `db.order.create` rejects with a Postgres unique-violation (P2002) instead
 * of silently creating a second order.
 *
 * Deliberately thrown rather than caught-and-recovered inside this function
 * (contrast `idempotency.ts`'s `saveIdempotentResponse`, which swallows its
 * own collision): every existing caller wraps `createOrderDirect`/
 * `createOrderFromCart` in an outer `prisma.$transaction(async (tx) => ...)`
 * that keeps using `tx` afterward (e.g. `finalizeOrderPayment`). Once one
 * query on a Postgres transaction fails, the WHOLE transaction is aborted —
 * any further query on that same `tx`, even a harmless read, fails with
 * "current transaction is aborted" — so recovering inside this function would
 * only trade one error for a more confusing one the instant the caller's
 * `$transaction` callback does anything else with `tx`. Throwing instead lets
 * Prisma roll the doomed transaction back cleanly; the caller catches this
 * error class OUTSIDE the failed `$transaction` call and decides the UX from
 * there (checkout.ts's buyNow* handlers show the same "duplicate pending"
 * toast `refuseDuplicateCheckout` already uses — see its doc comment).
 */
export class DuplicateCheckoutIntentError extends Error {
  constructor(public readonly checkoutIntentId: string) {
    super(`checkoutIntentId "${checkoutIntentId}" already has an order — refusing to create a second one`);
    this.name = "DuplicateCheckoutIntentError";
  }
}

/**
 * Look up the order a given `checkoutIntentId` already created — for a
 * `DuplicateCheckoutIntentError` catch site that wants to know more about the
 * existing order than "it exists" (today's bot UX doesn't need this; it's
 * exported for future consumers, e.g. Task 2/3's payment-rail wiring). Pass
 * the top-level `prisma` client, not the `tx` whose transaction just failed —
 * see `DuplicateCheckoutIntentError`'s doc comment for why that transaction
 * can no longer run any query.
 */
export function getOrderByCheckoutIntentId(db: Db, checkoutIntentId: string) {
  return db.order.findUnique({ where: { checkoutIntentId } });
}

const ZERO = new Decimal(0);
const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);
// Matches the cart's own cap (packages/db/src/crud/cart.ts) — the final
// server-side boundary regardless of how quantity reached this function
// (typed input, a crafted callback, or a cart row). Checkout-5 fix, security
// audit 2026-06-23.
const MAX_QTY_PER_ORDER = 99;
// Hard ceiling on total units across every active cart line, checked before
// any per-unit work starts (M-7 fix, backend audit 2026-07-31). Without this,
// createOrderFromCart's per-unit loop (allocateOneAvailableStock + an
// OrderItem row for every unit, with no cross-line cap — only the 99-per-line
// clamp above) could turn a large multi-line cart into thousands of queries
// inside one $transaction with Prisma's default 5s timeout, holding locks
// and a connection long enough to starve every other writer (the bot, webhooks,
// delivery transactions) before likely timing out and rolling back the whole
// order. 300 comfortably covers a real bulk-reseller checkout (several lines
// each up to the existing 99-per-line cap) while keeping the per-order unit
// count — and so the per-order query count — bounded to a small constant.
// Exported so callers (e.g. the storefront's performCheckout) can fail fast
// on the same cart BEFORE even opening the write transaction, not just once
// this function is already running inside it.
export const MAX_CART_ORDER_UNITS = 300;

// Fallback copy for the bulk-purchase channel broadcast (see
// finalizeDeliverySideEffects) when the admin hasn't set
// "bulk_purchase_broadcast_template" yet — lets the feature work the moment
// it's turned on, with a sensible default an admin can override.
const DEFAULT_BULK_BROADCAST_TEMPLATE = "Someone just purchased x{qty} of {product} - {denomination}!";

function assertValidQuantity(quantity: number, productName: string): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_ORDER) {
    throw new ValidationError("error.invalid_quantity", { product: productName });
  }
}

/**
 * Atomically bump a voucher's global usedCount, conditional on it not having
 * already hit usageLimit — a single updateMany's row-level atomicity makes
 * this safe under any DB isolation level, unlike a separate read-check then
 * increment (which is only safe if concurrent transactions happen to
 * serialize). Pricing-2 fix, security audit
 * 2026-06-23. Throws error.voucher_used_up if the limit was already hit.
 */
async function bumpVoucherUsage(db: Db, voucher: { id: number; usageLimit: number | null }): Promise<void> {
  const bumped = await db.voucher.updateMany({
    where: {
      id: voucher.id,
      OR: [{ usageLimit: null }, { usedCount: { lt: voucher.usageLimit ?? undefined } }],
    },
    data: { usedCount: { increment: 1 } },
  });
  if (bumped.count === 0) throw new ValidationError("error.voucher_used_up");
}

/**
 * Sentinel written to `Order.paymentRef` while a lazy gateway invoice
 * creation call (TokoPay/PayDisini/NOWPayments, apps/storefront's
 * checkout.ts `payView`) is in flight, so a second concurrent request for
 * the SAME order (e.g. a pay-page double-load) can't create a second
 * gateway invoice — `claimGatewaySlot`'s conditional `updateMany` is the
 * atomic guard, mirroring `bumpVoucherUsage`'s pattern above (Data-2 fix,
 * backend audit 2026-07-07).
 *
 * `paymentRef` also carries a UNIQUE index, so the sentinel is derived
 * per-order (rather than a single shared literal) — two DIFFERENT orders'
 * claims landing at the same instant then write distinct strings and never
 * collide at the DB level. Only two concurrent claims for the SAME order id
 * still collide, which is the actual race this guards against.
 *
 * The sentinel also embeds the wall-clock time it was written (`at`,
 * defaulting to `Date.now()`), so a claim that gets stuck — the process
 * crashes/restarts in the window between a successful claim and the matching
 * `commitGatewayResult`/`releaseGatewaySlot` (a real window: it spans an
 * external HTTP round-trip to the gateway) — doesn't wedge that order's
 * `paymentRef` forever. `claimGatewaySlot` below treats a same-order sentinel
 * older than `GATEWAY_CLAIM_TTL_MS` as abandoned and reclaimable (backend
 * audit 2026-07-07 final-review fix).
 */
export function gatewayClaimSentinel(orderId: number, at: number = Date.now()): string {
  return `__pending_gateway_claim__:${orderId}:${at}`;
}

const GATEWAY_CLAIM_SENTINEL_PREFIX = "__pending_gateway_claim__:";

/** A legitimate in-flight gateway call (a single HTTP round-trip) finishes in
 * well under this — anything older is presumed abandoned by a crashed/
 * restarted process, not a slow-but-alive request. */
const GATEWAY_CLAIM_TTL_MS = 30_000;

/** Parse the timestamp embedded in `paymentRef` iff it's a sentinel for THIS
 * order (never another order's, even though both share the same literal
 * prefix) — returns null for a real payload, a foreign-order sentinel, or no
 * value at all. */
function ownOrderSentinelAge(orderId: number, paymentRef: string | null): number | null {
  if (paymentRef == null) return null;
  const prefix = `${GATEWAY_CLAIM_SENTINEL_PREFIX}${orderId}:`;
  if (!paymentRef.startsWith(prefix)) return null;
  const ts = Number(paymentRef.slice(prefix.length));
  return Number.isFinite(ts) ? Date.now() - ts : null;
}

/**
 * Atomically claim the right to create this order's gateway invoice. Returns
 * the sentinel string this call wrote to `paymentRef` iff it won the claim
 * (the caller must pass this exact value back to `commitGatewayResult`/
 * `releaseGatewaySlot` so they guard on THIS instance's claim, not some other
 * concurrent one for the same order); returns null if another request
 * already holds a fresh claim for this same order.
 *
 * Two ways to win: (1) `paymentRef` was null (the common, no-prior-attempt
 * case), or (2) `paymentRef` is already a sentinel for this SAME order whose
 * embedded timestamp is older than `GATEWAY_CLAIM_TTL_MS` — a stuck claim
 * left behind by a crash — reclaimed via compare-and-swap on the exact stale
 * string just read, so two concurrent stale-reclaim attempts still can't
 * both win. The unique-violation catches are a defensive backstop (e.g. a
 * stale row already holding this exact sentinel string from a previous
 * crash) rather than the cross-order race, since the sentinel is per-order
 * (and now per-timestamp too).
 */
export async function claimGatewaySlot(db: Db, orderId: number): Promise<string | null> {
  const sentinel = gatewayClaimSentinel(orderId);
  try {
    const claimed = await db.order.updateMany({
      where: { id: orderId, paymentRef: null },
      data: { paymentRef: sentinel },
    });
    if (claimed.count === 1) return sentinel;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }

  // Lost the null-claim — check whether the current paymentRef is a stale
  // sentinel THIS SAME order wrote before something interrupted the gateway
  // call, and if so, reclaim it.
  const current = await db.order.findUnique({ where: { id: orderId }, select: { paymentRef: true } });
  const existingRef = current?.paymentRef ?? null;
  const age = ownOrderSentinelAge(orderId, existingRef);
  if (age === null || age < GATEWAY_CLAIM_TTL_MS) return null;

  try {
    const reclaimed = await db.order.updateMany({
      where: { id: orderId, paymentRef: existingRef! },
      data: { paymentRef: sentinel },
    });
    return reclaimed.count === 1 ? sentinel : null;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/**
 * Persist the real gateway payload once the external call succeeds,
 * replacing the claim sentinel `claimGatewaySlot` set. Conditional on
 * `paymentRef` still being the exact sentinel this claim instance wrote —
 * closes a narrow hole where an order that expires/cancels (or gets reclaimed
 * after a crash) mid-gateway-call could otherwise have its `paymentRef`
 * clobbered by a late-arriving commit. Returns true iff the write landed;
 * false means the sentinel was no longer in place (the order moved on, or a
 * newer claim already took over) — the caller already has the fetched
 * gateway payload in hand for this render, it just won't be cached for next
 * time.
 */
export async function commitGatewayResult(
  db: Db,
  orderId: number,
  sentinel: string,
  payload: unknown,
): Promise<boolean> {
  const committed = await db.order.updateMany({
    where: { id: orderId, paymentRef: sentinel },
    data: { paymentRef: JSON.stringify(payload) },
  });
  return committed.count === 1;
}

/**
 * Release a claim after the external gateway call fails, so a later request
 * can claim again. Conditional on `paymentRef` still being the exact
 * sentinel this claim instance wrote — a no-op if the slot was already
 * committed, released, or reclaimed by someone else (so this can never
 * release a DIFFERENT, still-valid claim for the same order).
 */
export async function releaseGatewaySlot(db: Db, orderId: number, sentinel: string): Promise<void> {
  await db.order.updateMany({
    where: { id: orderId, paymentRef: sentinel },
    data: { paymentRef: null },
  });
}

/**
 * Atomically switch which payment rail an Order is currently quoting: sets
 * `paymentMethod` to the new rail and clears `paymentRef` (so the new rail's
 * own `claimGatewaySlot` starts from the same null precondition a brand-new
 * order would). The crud-layer entry point `changePaymentRail`
 * (apps/order-bot/src/handlers/checkout.ts) calls instead of writing to
 * `Order` directly.
 *
 * The write is a compare-and-swap, the same idiom `claimGatewaySlot` above
 * uses, because the caller's status/ownership checks necessarily read the
 * order BEFORE opening the transaction that switches it — and a payment
 * confirmation can land in that window. The `updateMany`'s `where` therefore
 * pins two things at once:
 *
 *  - `status` to `expectedStatus` — the caller's belief about where the order
 *    was. A reconciler/webhook that moved it to PAID (or an expiry sweep that
 *    cancelled it) in the meantime makes this no longer match, so the switch
 *    is rejected rather than stamping a rail the buyer never paid onto an
 *    order that just settled.
 *  - `paymentRef` to the exact value this call itself just read. A lazy
 *    gateway-invoice claim (`claimGatewaySlot`) or commit
 *    (`commitGatewayResult`) landing mid-switch changes that column, and
 *    nulling it out from under an in-flight gateway call would orphan the
 *    invoice the gateway is about to return.
 *
 * Postgres row-locking is what makes this actually airtight rather than
 * merely narrow: a concurrent writer holding the row makes this UPDATE wait,
 * and Postgres then re-evaluates the WHERE against the row as that writer
 * left it — so `count` comes back 0 instead of clobbering the winner's work.
 *
 * Throws `error.order_not_pending` when the guard doesn't hold — the same key
 * `changePaymentRail`'s own pre-check already surfaces to the buyer, since a
 * guard failure is the same "this order moved on you" situation, just caught
 * atomically instead of via a stale read.
 *
 * Note this guards the ORDER row only. Two rail changes racing on an order
 * whose `paymentRef` is already null can both satisfy the guard (neither
 * changes a pinned column's value); what keeps that pair from opening two
 * live payment attempts is `Payment.pendingOrderId`'s unique claim in the
 * caller's same transaction (packages/db/src/crud/payments.ts), which lets
 * exactly one `createPaymentAttempt` win and rolls the loser's Order write
 * back with it.
 *
 * Returns the order's `paymentRef` exactly as it stood immediately before
 * this call cleared it. That string is the reconciliation matching key every
 * rail's webhook/poller reads (binanceInternal.ts's `byRef` map,
 * amountMatching.ts's transfer-note match, nowpaymentsReconcile.ts's invoice
 * id), so the caller must not simply drop it: hand it to
 * `expirePaymentAttempt`'s `reference` argument, and the retiring ledger row
 * keeps a record of what the old rail quoted.
 */
export async function setOrderPaymentRail(
  db: Db,
  args: { orderId: number; method: string; expectedStatus: string },
): Promise<{ previousPaymentRef: string | null }> {
  const current = await db.order.findUnique({
    where: { id: args.orderId },
    select: { paymentRef: true },
  });
  if (!current) throw new ValidationError("error.order_not_found");

  const claimed = await db.order.updateMany({
    where: { id: args.orderId, status: args.expectedStatus, paymentRef: current.paymentRef },
    data: { paymentMethod: args.method, paymentRef: null },
  });
  if (claimed.count !== 1) {
    // The order was deleted, its status moved off `expectedStatus`, or its
    // paymentRef changed under us — one error for all three, because each
    // means the same thing to the caller: the order this switch was decided
    // against no longer exists in that shape, so re-read it and decide again.
    throw new ValidationError("error.order_not_pending");
  }

  return { previousPaymentRef: current.paymentRef };
}

/** Fields of the linked buyer surfaced through Order's `user` relation.
 * web-admin's Orders and Payments pages spread the whole order object
 * straight into JSON (list/detail/CSV export, and the underpaid/pending-
 * internal-transfer lists on the Payments page — see binance_internal.ts's
 * `listPendingInternalOrders`, which reuses this same projection), reachable
 * by the lowest-privilege `readonly` admin role — so this must NEVER widen to
 * include `passwordHash` or `email` (backend audit finding H-4). Keep in
 * sync with what order-bot's payment reconcilers/pollers and web-admin's
 * Orders/Payments routes actually read off `order.user`: telegramId +
 * language for notification dispatch, fullName/username/loginUsername for
 * CSV export and eligibility labels. Mirrors the TICKET_USER_SELECT pattern
 * in crud/support.ts.
 *
 * `isGuest` + `guestEmail` are a deliberate, narrower exception to the same
 * H-4 note in webauth.ts (which bans leaking a registered account's `email`
 * into admin-facing JSON): `guestEmail` is not an account credential, it's
 * the contact address a guest shopper typed in at checkout, and the shop
 * admin needs it to reach that buyer about a manually-handled order. */
export const ORDER_USER_SELECT = {
  id: true,
  telegramId: true,
  username: true,
  fullName: true,
  loginUsername: true,
  language: true,
  isGuest: true,
  guestEmail: true,
} as const;

/** Eager-load shape matching the Python get_order selectinload set. */
const fullInclude = {
  items: { include: { product: true, stockItem: true } },
  user: { select: ORDER_USER_SELECT },
  voucher: true,
} satisfies Prisma.OrderInclude;

type CartLine = {
  productId: number;
  quantity: number;
  product: FlashFields & {
    price: Decimal.Value;
    resellerPrice: Decimal.Value | null;
    name: string;
    deliveryType: string;
    isActive: boolean;
    additionalFields: string | null;
    // The Denomination's own FK to the real catalog Product (voucher scope
    // matches against THIS id, not the Denomination's own id) — getCart's
    // `include: { product: true }` already selects the full Denomination row,
    // so this column is present at runtime; only the local type needed
    // widening to read it.
    productId: number;
    product: { category: { group: string | null } };
  };
};

type BulkRule = { minQuantity: number; discountPercent: Decimal.Value };

/**
 * The IDR credit a buyer asked to spend on a new order, as whole rupiah
 * (floored, so never more than asked; negative/absent is zero). The order's
 * net is whole rupiah (discounts are rounded where computed — B5, money
 * audit), so a whole-rupiah credit keeps the gateway remainder whole too.
 */
function idrWalletRequest(requested: Decimal.Value | undefined): Decimal {
  return Decimal.max(ZERO, new Decimal(requested ?? 0)).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
}

/**
 * What one unit costs this buyer, flash sale included (@app/core/flash owns the
 * rule; this is just the orders-domain entry point).
 *
 * `now` is passed in rather than read here so a single order creation prices
 * every line against ONE instant — otherwise a flash sale expiring midway
 * through the function could discount the subtotal loop but not the OrderItem
 * loop, leaving the order's stored line prices disagreeing with its total.
 */
function unitPrice(
  product: FlashFields & { price: Decimal.Value; resellerPrice: Decimal.Value | null },
  isReseller: boolean,
  now: Date = new Date(),
): Decimal {
  return effectiveUnitPrice(product, isReseller, now);
}

/** Pure: total bulk discount across all cart lines. The per-line rule (does it
 * apply, and how much does it take off) lives in @app/core/bulk so the bot's
 * confirmation screen and this function can't spell it differently. */
export function computeBulkDiscountForCart(
  cart: CartLine[],
  bulkRules: Record<number, BulkRule>,
  isReseller = false,
  now: Date = new Date(),
): Decimal {
  let total = ZERO;
  for (const ci of cart) {
    const itemSubtotal = unitPrice(ci.product, isReseller, now).times(ci.quantity);
    total = total.plus(bulkDiscountFor(itemSubtotal, bulkRules[ci.productId], ci.quantity));
  }
  return q4(total);
}

/** Exported so wallet_topup.ts (a bare-Order creator with no cart/stock of its
 * own) can mint the same collision-free order codes as every other order
 * creation path, instead of duplicating this retry loop. Pure/no side effects
 * beyond the read it already did — exporting it changes nothing for any
 * existing caller. */
export async function uniqueOrderCode(db: Db): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = generateOrderCode();
    const existing = await db.order.findUnique({
      where: { orderCode: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new Error("Could not generate a unique order code");
}

/**
 * Decrypts `item.stockItem.credentials` in place on an order fetched with
 * `fullInclude` — `StockItem.credentials` is encrypted at rest (Task 2, see
 * @app/core/credentialCrypto). This is the single choke point: every caller
 * of getOrder/getOrderByCodeFull (buyer-facing order
 * detail in the bot and storefront, the account-file DM builders, the
 * web-admin order detail page) reads `stockItem.credentials` expecting
 * plaintext, and all of them ultimately source the row from one of these
 * two functions (the state machine reads through getOrderRaw instead, and
 * never decrypts). Returns `order` unchanged if it's null (not-found) or has
 * no items with stock attached — cheap no-op for every non-manual-account
 * order kind. `Order.deliveredContent` (encrypted since Fase 6c) is decrypted
 * here too, throwing on an unreadable value like the stock credentials do.
 */
function withDecryptedStockCredentials<
  T extends {
    id: number;
    deliveredContent: string | null;
    items: Array<{ stockItem: { id: number; credentials: string } | null }>;
  },
>(order: T): T {
  // Cast at the end, not the object literal itself: TypeScript can't verify
  // a spread literal satisfies an unconstrained generic T even when it's
  // structurally identical apart from one string field's value — the shape
  // (item/stockItem fields, array length) is unchanged, only
  // stockItem.credentials's runtime value is.
  return {
    ...order,
    deliveredContent: decryptDeliveredContent(order.deliveredContent, order.id),
    items: order.items.map((item) =>
      item.stockItem
        ? {
            ...item,
            stockItem: { ...item.stockItem, credentials: decryptStockCredentials(item.stockItem.credentials, item.stockItem.id) },
          }
        : item,
    ),
  } as T;
}

/**
 * The order status plus its Digiflazz dispatch fields — what the admin and
 * buyer realtime streams push (the buyer stream maps it to a buyer-safe shape
 * before sending). Null when the order does not exist.
 */
export function getOrderDigiflazzSnapshot(db: Db, orderId: number) {
  return db.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      digiflazzStatus: true,
      digiflazzAttempts: true,
      digiflazzNextRecheckAt: true,
      digiflazzFailureDetail: true,
      accountDiagnosticNote: true,
    },
  });
}

export async function getOrder(db: Db, orderId: number) {
  const order = await db.order.findUnique({ where: { id: orderId }, include: fullInclude });
  return order ? withDecryptedStockCredentials(order) : order;
}

/**
 * getOrder WITHOUT decrypting anything: `stockItem.credentials` and
 * `deliveredContent` come back exactly as stored (ciphertext). For the order
 * state machine only — cancel, reject, credit-to-balance, approve's pre-claim
 * read, the expiry sweep — which decides on statuses, ids and amounts and
 * never needs a secret. Decrypting there made one unreadable row (a corrupt
 * value, or legacy plaintext once ALLOW_LEGACY_PLAINTEXT=false) block the
 * order from ever being cancelled or expired, leaking its reservation.
 *
 * Never deliver, display or log what this returns: a delivery reads through
 * getOrder/getOrderByCodeFull (which throw on an unreadable value), a page
 * through getOrderByCodeFullForDisplay.
 */
export async function getOrderRaw(db: Db, orderId: number) {
  return db.order.findUnique({ where: { id: orderId }, include: fullInclude });
}

export function getOrderByCode(db: Db, orderCode: string) {
  return db.order.findUnique({
    where: { orderCode },
    include: {
      items: {
        include: {
          product: {
            include: {
              product: { select: { digiflazzBrand: true, name: true } },
            },
          },
        },
      },
      user: { select: ORDER_USER_SELECT },
    },
  });
}

/** By code with the full include (items+stockItem+product, user, voucher) —
 * storefront order detail needs stockItem.credentials for DELIVERED orders. */
export async function getOrderByCodeFull(db: Db, orderCode: string) {
  const order = await db.order.findUnique({ where: { orderCode }, include: fullInclude });
  return order ? withDecryptedStockCredentials(order) : order;
}

type StockCredentialsOrder = {
  id: number;
  deliveredContent: string | null;
  items: Array<{ stockItem: { id: number; credentials: string } | null }>;
};
type DisplayItem<I extends StockCredentialsOrder["items"][number]> = Omit<I, "stockItem"> & {
  stockItem: (Omit<NonNullable<I["stockItem"]>, "credentials"> & { credentials: string | null }) | null;
};

/** DISPLAY-ONLY twin of withDecryptedStockCredentials: an unreadable row's
 * credentials become null (logged by row id) instead of failing the page.
 * Never use it on a delivery path — a delivery must throw and retry. */
type DisplayOrder<T extends StockCredentialsOrder> = Omit<T, "items"> & { items: Array<DisplayItem<T["items"][number]>> };

function withDisplayStockCredentials<T extends StockCredentialsOrder>(order: T): DisplayOrder<T> {
  // Cast for the same reason as withDecryptedStockCredentials: TS can't map a spread over a generic T.
  return {
    ...order,
    deliveredContent: tryDecryptDeliveredContent(order.deliveredContent, {
      orderId: order.id,
      purpose: "a buyer's order detail page",
    }),
    items: order.items.map((item) =>
      item.stockItem
        ? {
            ...item,
            stockItem: {
              ...item.stockItem,
              credentials: tryDecryptCredentials(item.stockItem.credentials, {
                stockItemId: item.stockItem.id,
                purpose: "a buyer's order detail page",
              }),
            },
          }
        : item,
    ),
  } as unknown as DisplayOrder<T>;
}

/** getOrderByCodeFull for the buyer's order detail PAGE only (unreadable
 * credentials come back null). Delivery must use getOrderByCodeFull. */
export async function getOrderByCodeFullForDisplay(db: Db, orderCode: string) {
  const order = await db.order.findUnique({ where: { orderCode }, include: fullInclude });
  return order ? withDisplayStockCredentials(order) : order;
}

/** The eager-loaded Order shape returned by getOrder/getOrderByCodeFull. */
type OrderWithIncludes = NonNullable<Awaited<ReturnType<typeof getOrder>>>;

/**
 * The amount actually received for an UNDERPAID order, regardless of which
 * amount-matching rail flagged it.
 *
 * MOVED to `./_underpaid` and re-exported here unchanged, so every existing
 * importer (`binance_internal.ts`, `wallet_topup.ts`, this module's tests,
 * `@app/db`) keeps working. It had to become a leaf module because
 * `ledgerPostings.ts` now reads the same figure — to split an
 * underpaid-but-delivered order's posting between the receivable and the
 * shortfall the shop absorbed — and this file already imports that one. See
 * `_underpaid.ts`'s own comment for the import cycle that avoids.
 */
export { findUnderpaidReceived } from "./_underpaid";

export async function createOrderFromCart(
  db: Db,
  args: {
    user: { id: number; role: string; walletBalance: Decimal.Value };
    /** Where the buyer is checking out (Telegram bot or website). A service
     * switched off for this channel is refused before anything is written. */
    channel: ServiceChannel;
    voucherCode?: string | null;
    walletAmount?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Persisted verbatim onto Order.customerData; null otherwise. */
    customerData?: string | null;
    /** Client-minted UUID identifying one checkout attempt (Task A1) — stamped
     * on the created Order under a DB-enforced unique constraint, so two
     * concurrent calls with the SAME value can never both create an order.
     * Omit for callers that don't need this guard (existing behavior,
     * unchanged); see {@link DuplicateCheckoutIntentError} for the collision
     * contract. */
    checkoutIntentId?: string | null;
  },
) {
  // Only lines whose product is still active are eligible to become an order
  // line — mirrors the storefront's performCheckout `activeCartLines` guard.
  // Filtering HERE (the actual order-creation read), not just at the caller,
  // closes the gap where an admin deactivates a manual_with_info denomination
  // between the buyer adding it to cart and completing checkout: without this,
  // performCheckout's homogeneity/customerData guards (which already filter by
  // isActive) would see an empty cart and skip both checks, while this
  // function's own unfiltered read would still create the order from the
  // now-inactive line (Finding #5, per-sku-delivery-flows audit 2026-07-13).
  //
  // Lock the cart first: a concurrent checkout of the same cart waits here and
  // then finds it empty, instead of creating a second order from it.
  await lockCartForCheckout(db, args.user.id);
  const rawCart = await getCart(db, args.user.id);
  const cart = rawCart.filter((ci) => ci.product.isActive);
  if (cart.length === 0) throw new ValidationError("error.cart_empty");
  for (const line of cart) {
    await assertServiceActive(db, line.product.product.category.group as CategoryGroup | null, args.channel);
  }
  // Total-units cap (M-7 fix) — checked first, before any per-line validation
  // or the order shell is even inserted, so an over-cap cart is rejected as
  // cheaply as possible (one cart read, one sum) rather than after sinking
  // work into subtotal/voucher math or reserving stock.
  const totalUnits = cart.reduce((sum, ci) => sum + ci.quantity, 0);
  if (totalUnits > MAX_CART_ORDER_UNITS) {
    throw new ValidationError("error.cart_too_large", { limit: MAX_CART_ORDER_UNITS });
  }
  // Cart rows are normally clamped to 1-99 by cart.ts, but the very first
  // insert path (addToCart's create branch) doesn't clamp — re-validate here
  // as the final server-side boundary (Checkout-5 fix, security audit
  // 2026-06-23).
  for (const ci of cart) assertValidQuantity(ci.quantity, ci.product.name);

  const isReseller = args.user.role === UserRole.RESELLER;
  // One instant for the whole order — see unitPrice's note on why a flash sale
  // must not be allowed to expire between the subtotal and the line prices.
  const pricedAt = new Date();

  // 1. Subtotal
  let subtotal = ZERO;
  for (const ci of cart) {
    subtotal = subtotal.plus(unitPrice(ci.product, isReseller, pricedAt).times(ci.quantity));
  }

  // 2. Bulk discount
  const bulkRules: Record<number, BulkRule> = {};
  for (const ci of cart) {
    const rule = await getBulkPricingForDenomination(db, ci.productId);
    if (rule) bulkRules[ci.productId] = rule;
  }
  const bulkDiscount = computeBulkDiscountForCart(cart, bulkRules, isReseller, pricedAt);

  // 3. Voucher
  let discount = ZERO;
  let voucher = null as Awaited<ReturnType<typeof getVoucherByCode>> | null;
  if (args.voucherCode) {
    voucher = await getVoucherByCode(db, args.voucherCode);
    if (!voucher) throw new ValidationError("error.voucher_not_found");
    await assertVoucherNotRedeemedByUser(db, voucher.id, args.user.id);

    // A SELECTED-scope voucher only discounts the cart lines whose
    // Denomination's parent Product is in its scoped set — sum just those
    // lines' subtotal/bulk-discount (net-of-bulk-discount eligible base).
    // ALL-scope (the default, and every pre-migration voucher) skips this
    // entirely and reuses the full cart's subtotal/bulkDiscount verbatim, so
    // this is byte-identical to the pre-scope behavior for that case.
    const eligibilityLines: EligibilityLine[] = cart.map((ci) => {
      const itemSubtotal = unitPrice(ci.product, isReseller, pricedAt).times(ci.quantity);
      return {
        catalogProductId: ci.product.productId,
        lineSubtotal: itemSubtotal,
        lineBulkDiscount: bulkDiscountFor(itemSubtotal, bulkRules[ci.productId], ci.quantity),
      };
    });
    const { eligibleSubtotal, eligibleBulkDiscount } = await computeEligibleAmounts(
      db,
      voucher,
      eligibilityLines,
      subtotal,
      bulkDiscount,
    );

    // Cap against the subtotal NET of the bulk discount (mirrors
    // createOrderDirect's matching step below) — capping against the gross
    // subtotal let a bulk discount + a voucher discount together exceed the
    // subtotal, producing a negative afterDiscount (and thus a negative
    // walletUsed persisted on the order) whenever both discounts were large
    // (Money-2 fix, backend audit 2026-07-07).
    discount = applyVoucherToSubtotal(
      voucher,
      subtotal.minus(bulkDiscount),
      eligibleSubtotal.minus(eligibleBulkDiscount),
      pricedAt,
    );
  }

  const afterDiscount = Decimal.max(ZERO, subtotal.minus(bulkDiscount).minus(discount));

  // 4. Wallet debit. Whole rupiah only (floored — never more than asked): the
  // discounts above are whole rupiah (B5, money audit), so `afterDiscount` is
  // too, and spending a fractional balance would leave a fractional remainder
  // for the gateway to round. Any sub-rupiah dust simply stays in the balance.
  const walletAmount = idrWalletRequest(args.walletAmount);
  const walletUsed = Decimal.min(walletAmount, afterDiscount);
  if (walletUsed.greaterThan(args.user.walletBalance)) {
    throw new ValidationError("error.insufficient_wallet");
  }

  // 5. Order code
  const orderCode = await uniqueOrderCode(db);

  // 5.5 Server-side re-validation of the buyer-submitted manual_with_info
  // answers — the final boundary before persisting them, regardless of
  // whether the caller (today, only performCheckout) already validated. A
  // cart is either all-auto or all-manual (the add-to-cart guard) with at
  // most one manual_with_info line, so this re-checks that single line's
  // CURRENT field spec/quantity rather than trusting args.customerData
  // verbatim — closes the gap where a stale/mismatched customerData (e.g. the
  // field spec or quantity changed after collection) would otherwise be
  // persisted as-is (Finding #4, per-sku-delivery-flows audit 2026-07-13).
  // Re-validating data performCheckout already validated is a safe no-op —
  // valid data stays valid.
  let customerDataToStore = args.customerData ?? null;
  const infoLines = cart.filter((ci) => ci.product.deliveryType === DeliveryType.MANUAL_WITH_INFO || !!ci.product.additionalFields);
  if (infoLines.length > 1) throw new ValidationError("error.customer_data_incomplete");
  const infoLine = infoLines[0];
  if (infoLine) {
    const fields = parseInputFields(infoLine.product.additionalFields);
    let parsedAnswers: unknown = null;
    if (args.customerData) {
      try {
        parsedAnswers = JSON.parse(args.customerData);
      } catch {
        parsedAnswers = null;
      }
    }
    customerDataToStore = JSON.stringify(validateCustomerData(fields, parsedAnswers, infoLine.quantity));
  }

  // 6. Persist order shell (need id for unique cents)
  let order;
  try {
    order = await db.order.create({
      data: {
        orderCode,
        userId: args.user.id,
        subtotalAmount: q4(subtotal),
        bulkDiscountAmount: q4(bulkDiscount),
        discountAmount: q4(discount),
        walletUsed,
        uniqueCents: ZERO,
        totalAmount: ZERO,
        voucherId: voucher ? voucher.id : null,
        status: OrderStatus.PENDING_PAYMENT,
        customerData: customerDataToStore,
        inputConfigSnapshot: infoLine ? inputConfigSnapshot(infoLine.product) : null,
        expiresAt: addMinutes(new Date(), config.PAYMENT_WINDOW_MINUTES),
        checkoutIntentId: args.checkoutIntentId ?? null,
      },
    });
  } catch (e) {
    // See DuplicateCheckoutIntentError's doc comment: only ever raised for a
    // genuine checkoutIntentId collision, and only when the caller opted into
    // the guard. The INSERT can also violate order_code: uniqueOrderCode only
    // checked the code was free, and a concurrent order can take it before
    // this INSERT lands. That is not a duplicate checkout, so it is told apart
    // by the violated column and rethrown as-is (backend audit E2 item 6).
    if (args.checkoutIntentId && isUniqueViolationOn(e, "checkout_intent_id")) {
      throw new DuplicateCheckoutIntentError(args.checkoutIntentId);
    }
    throw e;
  }

  // 7. Pre-check every AUTO line's availability before reserving anything, so
  // the common "you asked for more than we have" case fails before any row is
  // touched (rather than leaving earlier lines reserved). Then reserve stock
  // atomically (one row per unit, AVAILABLE -> RESERVED) and batch every
  // resulting OrderItem row into one createMany below instead of one create
  // per unit (M-7 fix). allocateOneAvailableStock is itself optimistic-locked,
  // so concurrent checkouts for the same product can never both reserve the
  // same row — that's the real race guard; the pre-check is just a fast-fail.
  // Out-of-stock is now caught HERE instead of first becoming visible at admin
  // approval (Checkout-2/Stock-1 fix, security audit 2026-06-23).
  // releaseOrderHolds (cancel/reject/expire) already returns RESERVED rows to
  // AVAILABLE.
  //
  // MANUAL / MANUAL_WITH_INFO lines carry NO stock: skip the pre-check and the
  // reservation, and create their OrderItem rows with stockItemId=null — they
  // are fulfilled by hand later (settlePaidOrder → fulfillManualOrder). (In
  // practice the storefront blocks mixing delivery types in one cart, so a cart
  // is either all-auto or all-manual, but this handles either line-by-line.)
  for (const ci of cart) {
    if (ci.product.deliveryType !== DeliveryType.AUTO) continue;
    const available = await countAvailableStock(db, ci.productId);
    if (available < ci.quantity) {
      throw new ValidationError("error.out_of_stock", { product: ci.product.name });
    }
  }
  // A checkout reservation is caused by the buyer, whoever clicked through to
  // get here (bot, storefront, or an admin placing an order on their behalf
  // still spends this buyer's stock).
  const buyerActor: StockEventActor = { type: StockActorType.CUSTOMER, customerId: args.user.id };
  // OrderItem rows are inserted BEFORE the stock they will hold (Fase 3b):
  // the RESERVED event has to carry `orderItemId`, which only exists once the
  // line row does. `createManyAndReturn` keeps that one insert per order
  // (M-7's batching, backend audit 2026-07-31) while handing back the ids.
  // Reserving after the line exists also closes the old window where a
  // RESERVED stock row had no order line to point back at.
  const orderItemsData: Prisma.OrderItemCreateManyInput[] = [];
  for (const ci of cart) {
    const unit = q4(unitPrice(ci.product, isReseller, pricedAt));
    const warrantyDays = (ci.product as unknown as { warrantyDays: number }).warrantyDays;
    for (let k = 0; k < ci.quantity; k++) {
      orderItemsData.push({
        orderId: order.id,
        productId: ci.productId,
        // Filled in by the reservation loop below for AUTO lines. MANUAL /
        // MANUAL_WITH_INFO lines carry no stock and stay null — they are
        // fulfilled by hand later (settlePaidOrder → fulfillManualOrder).
        stockItemId: null,
        quantity: 1,
        unitPrice: unit,
        costSnapshot: ci.product.costPrice,
        warrantyDaysSnapshot: warrantyDays,
        deliveryTypeSnapshot: ci.product.deliveryType,
        // Every new line starts PENDING (unpaid). Written explicitly rather
        // than left to a column default so that null keeps meaning exactly one
        // thing — "row predates this column" — see OrderItem.status in
        // schema.prisma.
        status: OrderItemStatus.PENDING,
      });
    }
  }
  const createdItems =
    orderItemsData.length > 0
      ? await db.orderItem.createManyAndReturn({
          data: orderItemsData,
          select: { id: true, productId: true },
        })
      : [];
  // createManyAndReturn promises no particular row order, and it doesn't need
  // to: every unit of one denomination is interchangeable here (same price,
  // same warranty snapshot, same delivery type), so each AUTO unit can take
  // any not-yet-paired line of its own denomination. Consumed via shift() so
  // a line is paired exactly once even if a cart somehow held the same
  // denomination twice.
  const unpairedItemIds = new Map<number, number[]>();
  for (const row of createdItems) {
    const existing = unpairedItemIds.get(row.productId);
    if (existing) existing.push(row.id);
    else unpairedItemIds.set(row.productId, [row.id]);
  }
  // Stock reservation is still one allocateOneAvailableStock call per unit
  // (it's individually optimistic-locked — see its doc comment — so each
  // unit's assignment genuinely depends on a fresh read of what's still
  // AVAILABLE after every earlier unit in this same order reserved its row;
  // that can't be batched without changing which stock item lands on which
  // line).
  for (const ci of cart) {
    if (ci.product.deliveryType !== DeliveryType.AUTO) continue;
    const lineItemIds = unpairedItemIds.get(ci.productId) ?? [];
    for (let k = 0; k < ci.quantity; k++) {
      const orderItemId = lineItemIds.shift();
      if (orderItemId === undefined) {
        throw new Error(
          `Cannot reserve stock for order ${order.orderCode}: the cart line for product ${ci.productId} asked for ${ci.quantity} units, but fewer order-item rows came back from the batch insert than the line needs. Every AUTO unit must have its own order-item row to reserve against.`,
        );
      }
      const reserved = await allocateOneAvailableStock(db, ci.productId, order.id, buyerActor, orderItemId);
      if (!reserved) {
        throw new ValidationError("error.out_of_stock", { product: ci.product.name });
      }
      await db.orderItem.update({ where: { id: orderItemId }, data: { stockItemId: reserved.id } });
    }
  }

  // 8. Final totals
  let finalBeforeCents = afterDiscount.minus(walletUsed);
  if (finalBeforeCents.lessThan(0)) finalBeforeCents = ZERO;
  const cents = config.USE_UNIQUE_CENTS ? computeUniqueCents(order.id) : ZERO;
  await db.order.update({
    where: { id: order.id },
    data: { uniqueCents: cents, totalAmount: q4(finalBeforeCents.plus(cents)) },
  });

  // 9. Wallet debit (atomic). Cart orders are charged in IDR (TokoPay/QRIS),
  //    so the IDR credit balance is spent.
  if (walletUsed.greaterThan(0)) {
    await adjustWallet(db, args.user.id, walletUsed.negated(), { currency: "IDR", reason: "order_payment", orderId: order.id });
  }

  // 10. Bump voucher usage (atomic conditional — Pricing-2 fix) + record this
  // user's redemption (1x/user; the unique index on (voucherId, userId) is
  // the race-safety net for two concurrent checkouts that both passed the
  // check in step 3).
  if (voucher) {
    await bumpVoucherUsage(db, voucher);
    await db.voucherRedemption.create({
      data: { voucherId: voucher.id, userId: args.user.id, orderId: order.id },
    });
  }

  // 11. Clear cart
  await clearCart(db, args.user.id);

  logger.info(`Created order ${orderCode} for user ${args.user.id} with totals computed`);
  return getOrder(db, order.id);
}

export async function createOrderDirect(
  db: Db,
  args: {
    user: { id: number; role: string; walletBalance?: Decimal.Value };
    /** Where the buyer is checking out (Telegram bot or website). A service
     * switched off for this channel is refused before anything is written. */
    channel: ServiceChannel;
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    /** IDR credit balance to spend on this order (clamped to order total). */
    walletAmount?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Persisted verbatim onto Order.customerData; null otherwise. */
    customerData?: string | null;
    /** Client-minted UUID identifying one checkout attempt (Task A1) — stamped
     * on the created Order under a DB-enforced unique constraint, so two
     * concurrent calls with the SAME value can never both create an order.
     * Omit for callers that don't need this guard (existing behavior,
     * unchanged); see {@link DuplicateCheckoutIntentError} for the collision
     * contract. */
    checkoutIntentId?: string | null;
  },
) {
  // args.productId is a denomination id (the sellable SKU).
  const product = await db.denomination.findUnique({
    where: { id: args.productId },
    include: { product: { include: { category: true } } },
  });
  if (!product || !product.isActive || !product.product.isActive || product.product.isArchived || !product.product.category.isActive) throw new ValidationError("error.out_of_stock", { product: "(unknown)" });
  if (product.autoDeliverySource === "digiflazz" && (!product.supplierSku || args.quantity !== 1 || parseInputFields(product.additionalFields).length === 0)) throw new ValidationError("error.customer_data_incomplete");
  await assertServiceActive(db, product.product.category.group as CategoryGroup | null, args.channel);
  // Quantity can arrive from a crafted callback (v1:payq:<pid>:<qty>), not
  // just the UI's clamped stepper — validate it server-side (Checkout-5 fix,
  // security audit 2026-06-23).
  assertValidQuantity(args.quantity, product.name);

  const isReseller = args.user.role === UserRole.RESELLER;
  const pricedAt = new Date();
  const unit = unitPrice(product, isReseller, pricedAt);
  const subtotal = q4(unit.times(args.quantity));

  // Bulk discount — same helper computeBulkDiscountForCart and the bot's
  // confirmation screen use, so a single-SKU order can never be discounted by a
  // different rule than the cart path would have applied.
  const rule = await getBulkPricingForDenomination(db, args.productId);
  const bulkDiscount = bulkDiscountFor(subtotal, rule, args.quantity);

  // Voucher
  let voucher = null as Awaited<ReturnType<typeof getVoucherByCode>> | null;
  let voucherDiscount = ZERO;
  if (args.voucherCode) {
    voucher = await getVoucherByCode(db, args.voucherCode);
    if (!voucher) throw new ValidationError("error.voucher_not_found");
    await assertVoucherNotRedeemedByUser(db, voucher.id, args.user.id);

    // Single-line order: a SELECTED-scope voucher either matches this one SKU
    // entirely or not at all — no partial-line math needed, unlike the cart
    // path. ALL-scope (the default) is always eligible, byte-identical to the
    // pre-scope behavior.
    const { eligibleSubtotal, eligibleBulkDiscount } = await computeEligibleAmounts(
      db,
      voucher,
      [{ catalogProductId: product.productId, lineSubtotal: subtotal, lineBulkDiscount: bulkDiscount }],
      subtotal,
      bulkDiscount,
    );

    voucherDiscount = applyVoucherToSubtotal(
      voucher,
      subtotal.minus(bulkDiscount),
      eligibleSubtotal.minus(eligibleBulkDiscount),
      pricedAt,
    );
  }

  const orderCode = await uniqueOrderCode(db);

  // Manual (manual / manual_with_info) SKUs carry NO stock — skip the
  // availability pre-check and the per-unit reservation below, and create the
  // OrderItem rows with stockItemId=null (fulfilled by hand via
  // settlePaidOrder → fulfillManualOrder). Auto SKUs behave exactly as before.
  const isManual = product.deliveryType !== DeliveryType.AUTO;

  // Pre-check before reserving anything (fast-fail on the common "ordered too
  // much" case) — see createOrderFromCart's matching guard for the rationale.
  if (!isManual) {
    const available = await countAvailableStock(db, args.productId);
    if (available < args.quantity) {
      throw new ValidationError("error.out_of_stock", { product: product.name });
    }
  }

  // Server-side re-validation of manual_with_info customerData — the final
  // boundary before persisting it, regardless of which of this function's
  // several callers (the bot's 7 buyNow* handlers + completeOrderWithWallet +
  // wallet_checkout's completeOrderWithWalletCredit) supplied it. The bot's
  // info-collection gate only checks scratch.customerData is PRESENT, not
  // that it still matches the CURRENT product/quantity (e.g. after the buyer
  // backs out and changes quantity, or switches products, without the wizard
  // re-running) — this re-validates it against the denomination's actual
  // field spec and the actual quantity being ordered, mirroring the
  // storefront's performCheckout, which already does the equivalent check
  // before calling createOrderFromCart (Finding #4, per-sku-delivery-flows
  // audit 2026-07-13). Re-validating already-valid data is a safe no-op.
  let customerDataToStore = args.customerData ?? null;
  if (product.deliveryType === DeliveryType.MANUAL_WITH_INFO || product.additionalFields) {
    const fields = parseInputFields(product.additionalFields);
    let parsedAnswers: unknown = null;
    if (args.customerData) {
      try {
        parsedAnswers = JSON.parse(args.customerData);
      } catch {
        parsedAnswers = null;
      }
    }
    customerDataToStore = JSON.stringify(validateCustomerData(fields, parsedAnswers, args.quantity));
  }

  let order;
  try {
    order = await db.order.create({
      data: {
        orderCode,
        userId: args.user.id,
        subtotalAmount: subtotal,
        bulkDiscountAmount: bulkDiscount,
        discountAmount: voucherDiscount,
        voucherId: voucher ? voucher.id : null,
        walletUsed: ZERO,
        uniqueCents: ZERO,
        totalAmount: ZERO,
        status: OrderStatus.PENDING_PAYMENT,
        customerData: customerDataToStore,
        inputConfigSnapshot: product.additionalFields ? inputConfigSnapshot(product) : null,
        expiresAt: addMinutes(new Date(), config.PAYMENT_WINDOW_MINUTES),
        checkoutIntentId: args.checkoutIntentId ?? null,
      },
    });
  } catch (e) {
    // See DuplicateCheckoutIntentError's doc comment: only ever raised for a
    // genuine checkoutIntentId collision, and only when the caller opted into
    // the guard. The INSERT can also violate order_code: uniqueOrderCode only
    // checked the code was free, and a concurrent order can take it before
    // this INSERT lands. That is not a duplicate checkout, so it is told apart
    // by the violated column and rethrown as-is (backend audit E2 item 6).
    if (args.checkoutIntentId && isUniqueViolationOn(e, "checkout_intent_id")) {
      throw new DuplicateCheckoutIntentError(args.checkoutIntentId);
    }
    throw e;
  }

  // Lines first, stock second — same ordering (and same reason: the RESERVED
  // event needs `orderItemId`) as createOrderFromCart's matching block; see
  // its comments for the full rationale. MANUAL keeps stockless OrderItems.
  const createdItems = await db.orderItem.createManyAndReturn({
    data: Array.from({ length: args.quantity }, () => ({
      orderId: order.id,
      productId: args.productId,
      stockItemId: null,
      quantity: 1,
      unitPrice: q4(unit),
      costSnapshot: product.costPrice,
      warrantyDaysSnapshot: product.warrantyDays,
      deliveryTypeSnapshot: product.deliveryType,
      // Same as createOrderFromCart's loop — explicit PENDING, never a
      // column default.
      status: OrderItemStatus.PENDING,
    })),
    select: { id: true },
  });
  if (!isManual) {
    const buyerActor: StockEventActor = { type: StockActorType.CUSTOMER, customerId: args.user.id };
    for (const item of createdItems) {
      const reserved = await allocateOneAvailableStock(db, args.productId, order.id, buyerActor, item.id);
      if (!reserved) {
        throw new ValidationError("error.out_of_stock", { product: product.name });
      }
      await db.orderItem.update({ where: { id: item.id }, data: { stockItemId: reserved.id } });
    }
  }

  if (voucher) {
    // Atomic conditional bump — Pricing-2 fix, security audit 2026-06-23.
    await bumpVoucherUsage(db, voucher);
    await db.voucherRedemption.create({
      data: { voucherId: voucher.id, userId: args.user.id, orderId: order.id },
    });
  }

  // Clamped for the same reason createOrderFromCart clamps (Money-2): a
  // negative here would be persisted as a negative walletUsed/totalAmount and
  // corrupt the audit trail. The voucher cap above makes it unreachable today —
  // the clamp keeps it unreachable if either discount's own guards ever slip.
  const afterDiscount = Decimal.max(ZERO, subtotal.minus(bulkDiscount).minus(voucherDiscount));

  // IDR wallet credit — mirrors createOrderFromCart's deduction logic.
  const walletAmountReq = idrWalletRequest(args.walletAmount);
  const walletUsed = q4(Decimal.min(walletAmountReq, afterDiscount));
  if (walletUsed.greaterThan(ZERO)) {
    const balance = new Decimal(args.user.walletBalance ?? 0);
    if (walletUsed.greaterThan(balance)) throw new ValidationError("error.insufficient_wallet");
  }

  const cents = config.USE_UNIQUE_CENTS ? computeUniqueCents(order.id) : ZERO;
  await db.order.update({
    where: { id: order.id },
    data: { uniqueCents: cents, walletUsed, totalAmount: q4(afterDiscount.minus(walletUsed).plus(cents)) },
  });

  if (walletUsed.greaterThan(ZERO)) {
    await adjustWallet(db, args.user.id, walletUsed.negated(), {
      currency: "IDR",
      reason: "order_payment",
      orderId: order.id,
    });
  }

  logger.info(
    `Created direct order ${orderCode} for user ${args.user.id}, product ${args.productId}, quantity ${args.quantity}`,
  );
  return getOrder(db, order.id);
}

/**
 * Spend the buyer's **USDT** credit balance on an already-finalized USDT order
 * (totals + currency stamped by `finalizeOrderPayment`). Mirrors the IDR
 * wallet-apply in `createOrderFromCart`, but reads/writes the USDT balance and
 * debits via `adjustWallet(..., { currency: "USDT" })`.
 *
 * `walletAmount` is the buyer-requested credit to apply; the applied amount is
 * clamped to the order total (never auto-drains the whole balance) and to the
 * available USDT balance (overdraw → error.insufficient_wallet). Re-derives the
 * USDT total net of the unique cents so the cents stay payable on-chain.
 *
 * No-op (and leaves walletUsed = 0) when `walletAmount` is unset/≤0 — current
 * callers pass nothing yet, so the path is currency-correct and ready for a
 * future caller without changing today's behavior. Run inside the creation tx.
 */
export async function applyUsdtWalletToOrder(
  db: Db,
  orderId: number,
  walletAmount: Decimal.Value | null | undefined,
): Promise<void> {
  const requested = q4(Decimal.max(ZERO, new Decimal(walletAmount ?? 0)));
  if (requested.lessThanOrEqualTo(0)) return;

  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const user = await getUser(db, order.userId);
  if (!user) throw new ValidationError("error.order_not_found");

  // The payable USDT amount before unique-cents noise — credit balance covers
  // the goods, the unique cents stay on the on-chain transfer.
  const payable = Decimal.max(ZERO, new Decimal(order.totalAmount).minus(order.uniqueCents));
  const walletUsed = q4(Decimal.min(requested, payable));
  if (walletUsed.lessThanOrEqualTo(0)) return;

  // A credit that covers everything but the unique cents would leave a gateway
  // order asking the buyer to send nothing but matching noise (A3, money audit
  // P1). A fully covered order is settled on the WALLET rail, which carries no
  // cents; on any other rail it is refused before the debit below, with the
  // same "nothing left to collect" refusal `finalizeOrderPayment` gives it when
  // the caller passes the credit there too (every current caller does — this is
  // the backstop for one that forgets).
  if (order.paymentMethod !== PaymentMethod.WALLET && walletUsed.greaterThanOrEqualTo(payable)) {
    throw new ValidationError("error.amount_too_small_for_rail", { currency: OrderCurrency.USDT });
  }

  const balance = new Decimal(user.walletBalanceUsdt);
  if (walletUsed.greaterThan(balance)) {
    throw new ValidationError("error.insufficient_wallet");
  }

  await adjustWallet(db, order.userId, walletUsed.negated(), {
    currency: "USDT",
    reason: "order_payment",
    orderId: order.id,
  });
  await db.order.update({
    where: { id: order.id },
    data: {
      walletUsed,
      totalAmount: q4(new Decimal(order.totalAmount).minus(walletUsed)),
    },
  });
}

/**
 * List/summary rows are spread straight into admin JSON, so they never carry
 * the delivered secret; only getOrder's detail/reveal/resend paths read it.
 */
export function withoutDeliveredContent<T extends { deliveredContent: string | null }>(
  order: T,
): Omit<T, "deliveredContent"> {
  const { deliveredContent: _deliveredContent, ...rest } = order;
  return rest;
}

export async function listUserOrders(db: Db, userId: number, limit = 5, offset = 0) {
  const orders = await db.order.findMany({
    where: { userId, kind: OrderKind.PRODUCT },
    orderBy: { createdAt: "desc" },
    skip: offset,
    take: limit,
    include: { items: { include: { product: true } } },
  });
  return orders.map(withoutDeliveredContent);
}

export function countUserOrders(db: Db, userId: number) {
  return db.order.count({ where: { userId, kind: OrderKind.PRODUCT } });
}

/**
 * Site-wide fulfilment figures for the storefront home: how many orders have
 * actually been delivered and how many distinct customers have bought. Real
 * numbers replace the old hard-coded "10.000+" stats so the page stays honest.
 */
export async function shopFulfilmentStats(
  db: Db,
): Promise<{ deliveredOrders: number; customers: number }> {
  const [deliveredOrders, buyers] = await Promise.all([
    db.order.count({ where: { status: OrderStatus.DELIVERED, kind: OrderKind.PRODUCT } }),
    db.order.groupBy({
      by: ["userId"],
      where: { status: OrderStatus.DELIVERED, kind: OrderKind.PRODUCT },
    }),
  ]);
  return { deliveredOrders, customers: buyers.length };
}

export function countUserPendingOrders(db: Db, userId: number) {
  return db.order.count({
    where: { userId, status: OrderStatus.PENDING_PAYMENT },
  });
}

/**
 * A buyer's delivered PRODUCT orders, for lists that only need ids and product
 * names (the storefront's "orders to review"). Carries no secret at all — no
 * stock row, no deliveredContent — so it never decrypts, and one unreadable
 * row can't fail the page. PRODUCT only: a wallet top-up can't be reviewed,
 * and letting top-ups in would eat the row limit.
 */
export async function listUserDeliveredOrders(db: Db, userId: number, limit = 50) {
  const orders = await db.order.findMany({
    where: { userId, status: OrderStatus.DELIVERED, kind: OrderKind.PRODUCT },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { items: { include: { product: true } } },
  });
  return orders.map(withoutDeliveredContent);
}

export async function attachPaymentProof(
  db: Db,
  orderId: number,
  args: { fileId: string; txid: string },
) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new ValidationError("error.order_not_pending");
  }
  await db.order.update({
    where: { id: orderId },
    data: {
      paymentProofFileId: args.fileId,
      binanceTxid: args.txid,
      status: OrderStatus.PENDING_VERIFICATION,
    },
  });
  return getOrder(db, orderId);
}

export function listPendingVerifications(db: Db, limit = 50) {
  return db.order.findMany({
    where: { status: OrderStatus.PENDING_VERIFICATION },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { items: { include: { product: true } }, user: true },
  });
}

export function listExpiredPendingOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt: { not: null, lt: now },
    },
    include: { user: true },
  });
}

// ---- Operational status counters (admin queues + Orders-page tab badges) ---
//
// KIND-AGNOSTIC ON PURPOSE (Financial Ledger M6, Task 6a). Financial Ledger
// M6 narrowed every SALES aggregate to `kind: OrderKind.PRODUCT` — see
// `ORDER_KIND_SALES_FILTER` in crud/revenue.ts, plus `ordersByStatus`/
// `ordersByStatusSince` in crud/reports.ts and the spend/revenue functions in
// crud/users.ts. The counters in this block were reviewed in that pass and
// deliberately left counting BOTH kinds. Do not "finish the job" here.
//
// They are not sales metrics. They feed exactly two surfaces:
//   - the dashboard's Operation Center and Pending Actions cards — admin
//     work-queue counters, each one deep-linking to the Orders page filtered
//     by that same status (apps/web-admin/client/src/components/dashboard/
//     OperationCenter.tsx);
//   - the Orders page's own KPI row and status-tab count badges
//     (pages/orders/OrderStatusTabs.tsx, via GET /api/orders/kpis).
//
// The Orders list behind both is itself kind-agnostic (`listOrders` applies no
// kind filter, and admins genuinely resolve top-up orders there — see
// routes/api/orders.ts's WALLET_TOPUP branches), so filtering these would
// (a) make every tab badge contradict the list it labels, and (b) hide real
// work: an UNDERPAID or expired wallet top-up needs a human exactly as much
// as an UNDERPAID product order does. `countOrders`/`OrderFilter` below is the
// escape hatch for a caller that genuinely wants one kind only.

/** Orders awaiting payment confirmation right now — covers every payment
 * method's pre-confirmation states, including the Bybit BSC on-chain
 * milestones ("Pending Payments" on the dashboard). Counts both order kinds —
 * see this block's header comment. */
export function countPendingPaymentLike(db: Db): Promise<number> {
  return db.order.count({
    where: { status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING] } },
  });
}

/** Orders confirmed-paid but not yet delivered ("Orders Processing"). */
export function countProcessing(db: Db): Promise<number> {
  return db.order.count({ where: { status: { in: [OrderStatus.CONFIRMED, OrderStatus.PAID] } } });
}

/** Orders awaiting admin payment-proof confirmation — the true count, unlike
 * `listPendingVerifications(db, limit)`, which is capped at its page size. */
export function countPendingVerifications(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.PENDING_VERIFICATION } });
}

/** Orders an admin must manually resolve (paid short of the expected total). */
export function countUnderpaid(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.UNDERPAID } });
}

/**
 * Manual/manual_with_info orders paid and awaiting an admin to hand-type and
 * send the account content ("Awaiting Fulfillment" on the dashboard).
 * Deliberately NOT named countProcessing — that pre-existing function counts
 * CONFIRMED/PAID orders (a different, payment-gateway-in-flight concept) and
 * must not be touched or confused with this one.
 *
 * This is the one counter in this block that needs no `kind` filter for a
 * STRUCTURAL reason rather than a product one: a `WALLET_TOPUP` order can never
 * hold `PROCESSING`. Only `settlePaidOrder`'s MANUAL branch puts a fresh order
 * there, and that function refuses a top-up before the branch split (see
 * settlePaidOrder.test.ts, "wallet top-ups cannot be settled through the
 * product-delivery path"); even without that guard the branch is unreachable,
 * because `isManual` reads `order.items.some(...)` and a top-up order has zero
 * `OrderItem` rows. The only other writer — digiflazz.ts's dispatcher —
 * re-asserts `PROCESSING` on orders that already hold it and additionally
 * requires `items: { some: ... }`. So a filter here would be dead weight that
 * implies the invariant is weaker than it is.
 */
export function countAwaitingManualFulfillment(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.PROCESSING } });
}

/** Orders successfully delivered — the Orders page KPI's "Delivered" count and
 * its "Delivered" tab badge, so it counts both order kinds to stay equal to
 * the row count that tab shows (see this block's header comment). For
 * delivered PRODUCT SALES, use revenue.ts's `revenueSummary`/`ordersByDay` or
 * `countOrders(db, { kind: OrderKind.PRODUCT, status: DELIVERED })`. */
export function countDelivered(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.DELIVERED } });
}

/** Orders voided (admin-cancelled or rejected) — folded together for the
 * Orders page KPI's "Cancelled" count, matching the display bucket
 * OrderStatusBadge groups them into on the client. Counts both order kinds,
 * for the same tab-badge reason as `countDelivered` above. */
export function countCancelled(db: Db): Promise<number> {
  return db.order.count({ where: { status: { in: [OrderStatus.CANCELLED, OrderStatus.REJECTED] } } });
}

/** PENDING_PAYMENT orders whose window has already lapsed — the count form of `listExpiredPendingOrders`. */
export function countExpiredPending(db: Db, now: Date): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.PENDING_PAYMENT, expiresAt: { not: null, lt: now } } });
}

// ---- SLA widgets (web-admin dashboard) ------------------------------------

/** Orders aging in PENDING_VERIFICATION beyond `cutoff` (oldest first). */
export function listOrdersAgingInVerification(db: Db, cutoff: Date, limit = 50) {
  return db.order.findMany({
    where: { status: OrderStatus.PENDING_VERIFICATION, createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { user: true },
  });
}

/** PENDING_PAYMENT orders whose window expires within [now, until] (soonest first). */
export function listExpiringPendingPayments(db: Db, now: Date, until: Date, limit = 50) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt: { not: null, gte: now, lte: until },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
    include: { user: true },
  });
}

/**
 * The line's reserved row was marked DEAD by an admin (before this order's
 * snapshot was read, or in between) and is still tied to this order. It has
 * nothing to release — it stays DEAD, keeps its `orderId` and its ledger — but
 * the voided order's line must stop pointing at it, like a released row's
 * does. Left linked, the integrity check reported it as pre-3b legacy data and
 * soft-deleting the dead row was refused forever. No event: nothing about the
 * row changes, and its RESERVED event already records the order and line.
 */
async function unlinkIfDeadHere(db: Db, orderId: number, orderItemId: number, stockItemId: number): Promise<void> {
  const deadHere = await db.stockItem.count({
    where: { id: stockItemId, status: StockStatus.DEAD, orderId },
  });
  if (deadHere !== 1) return;
  await db.orderItem.updateMany({ where: { id: orderItemId, stockItemId }, data: { stockItemId: null } });
}

/**
 * Release any reserved stock + refund wallet + roll back voucher usage.
 *
 * Called from three places with genuinely different accounting consequences —
 * `rejectOrder`, `cancelOrder` and `creditOrderToBalance` — which is why the
 * ledger posting for the wallet release is decided HERE, from the order's own
 * posting history, rather than at each caller. Only the
 * `creditOrderToBalance`-on-an-already-settled-order path has anything to post;
 * see `postOrderHoldReleasePosting` for the full rule and for why posting on the
 * other two paths would corrupt `wallet_liability`.
 *
 * Releasing a row ALSO clears the line's `OrderItem.stockItemId` (audit L-6,
 * Fase 3b). Before that, a cancelled/expired/rejected order kept pointing at
 * a row the next checkout immediately re-reserved, so two OrderItems ended up
 * on one stock row — a duplicate pointer that made "who got this credential?"
 * unanswerable and would break the unique claim column a later phase adds.
 * The RESERVATION_RELEASED event written here is the trace that replaces the
 * pointer: it keeps the order, the line and the actor on record.
 */
async function releaseOrderHolds(
  db: Db,
  order: NonNullable<Awaited<ReturnType<typeof getOrderRaw>>>,
  actor: StockEventActor,
  occurredAt: Date = new Date(),
) {
  for (const item of order.items) {
    if (!item.stockItem) continue;
    if (item.stockItem.status === StockStatus.RESERVED) {
      // Release only a row THIS order still holds. `order` is a snapshot taken
      // before this function ran, and the row can have moved on since: an
      // expiry sweep can read O1, stall, and by the time it writes, a competing
      // cancel has released the row and another buyer's checkout has
      // re-reserved it. An unconditional update would steal that live
      // reservation and log a release that never happened for this order, so
      // the owner is part of the condition and the event and the pointer clear
      // follow only the attempt that actually won.
      const res = await db.stockItem.updateMany({
        where: { id: item.stockItem.id, status: StockStatus.RESERVED, orderId: order.id },
        data: { status: StockStatus.AVAILABLE, orderId: null, reservedAt: null },
      });
      if (res.count !== 1) {
        await unlinkIfDeadHere(db, order.id, item.id, item.stockItem.id);
        continue;
      }
      await recordStockEvent(db, {
        stockItemId: item.stockItem.id,
        eventType: StockEventType.RESERVATION_RELEASED,
        fromStatus: StockStatus.RESERVED,
        toStatus: StockStatus.AVAILABLE,
        orderId: order.id,
        orderItemId: item.id,
        actor,
        occurredAt,
      });
      await db.orderItem.update({ where: { id: item.id }, data: { stockItemId: null } });
    } else {
      await unlinkIfDeadHere(db, order.id, item.id, item.stockItem.id);
    }
  }
  if (new Decimal(order.walletUsed).greaterThan(0)) {
    // Credit back to the balance matching the order's currency: an order spends
    // and is refunded against the same credit balance (IDR or USDT).
    const { transactionId } = await adjustWallet(db, order.userId, order.walletUsed, {
      currency: order.currency === "USDT" ? "USDT" : "IDR",
      allowNegative: true,
      reason: "order_refund",
      orderId: order.id,
    });
    await postOrderHoldReleasePosting(db, {
      walletTransactionId: transactionId,
      orderId: order.id,
      orderCode: order.orderCode,
      occurredAt,
    });
  }
  if (order.voucherId) {
    // One guarded decrement; never below zero even when two releases race.
    await releaseVoucherUse(db, order.voucherId);
    // M-2 (backend audit, 2026-07-31): also clear the (voucherId, userId)
    // redemption row so a cancelled/rejected/expired order doesn't
    // permanently lock this buyer out of a one-per-user voucher —
    // assertVoucherNotRedeemedByUser checks for this row's existence, not
    // usedCount. deleteMany (not delete) so this stays a no-op if the row
    // was already cleared, instead of throwing P2025.
    await db.voucherRedemption.deleteMany({
      where: { voucherId: order.voucherId, userId: order.userId },
    });
  }
}

/**
 * H-2 guard (backend audit, 2026-07-31): `rejectOrder`/`cancelOrder` both end
 * at a terminal state (REJECTED/CANCELLED); `creditOrderToBalance` refuses to
 * touch a REJECTED one afterward ("error.order_terminal"), and only credits a
 * CANCELLED one through a separate, admin-noticed recovery path — so once an order's
 * `paidAt` is set (the same "was this actually paid" signal `settlePaidOrder`
 * stamps for a real payment event, see its own doc-comment), rejecting or
 * cancelling it directly would strand that payment forever instead of
 * releasing it back to the buyer. Refuse the transition and point the caller
 * at `creditOrderToBalance` instead — unless this exact order was already
 * credited (the same `unfulfilled_credit` ledger check `creditOrderToBalance`
 * uses for its own double-credit guard), which would mean a caller is
 * legitimately finishing a credit that, for some reason, didn't already
 * leave the order CANCELLED.
 */
async function assertNotPaidWithoutCredit(
  db: Db,
  order: { id: number; paidAt: Date | null },
): Promise<void> {
  if (!order.paidAt) return;
  const alreadyCredited = await db.walletTransaction.findFirst({
    where: { orderId: order.id, reason: "unfulfilled_credit" },
  });
  if (!alreadyCredited) {
    throw new ValidationError("error.order_paid_needs_credit");
  }
}

/**
 * Void a not-yet-delivered order and release everything it was holding.
 *
 * `actor` is required and explicit (Fase 3b): the stock ledger has to say who
 * released each reservation, and `reason` is free text every caller formats
 * differently — a buyer tap, an admin note, an expiry sweep — so it can't
 * carry attribution. `reason` stays what it always was: the human-readable
 * note appended to `adminNote` and the status-history meta (plus the
 * `user_cancelled` anti-abuse guard below).
 */
export async function cancelOrder(db: Db, orderId: number, reason: string, actor: StockEventActor) {
  const order = await getOrderRaw(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (
    ORDER_HOLD_RELEASED_STATUSES.includes(order.status as OrderStatus) ||
    order.status === OrderStatus.REFUNDED
  ) {
    return order;
  }
  if (order.status === OrderStatus.DELIVERED) {
    throw new ValidationError("error.order_already_delivered");
  }
  await assertNotPaidWithoutCredit(db, order);
  // Prevent abuse: fake proof then cancel to recycle stock. A customer can't
  // self-cancel once their crypto is already incoming/confirming on-chain
  // either (PAYMENT_DETECTED/CONFIRMING/CONFIRMED) — same "money is already
  // in motion" rationale, just for the Bybit BSC auto-confirm rail instead of
  // the manual-proof rail. Admin-initiated cancels (any other `reason`) are
  // unaffected.
  if (
    reason === "user_cancelled" &&
    (order.status === OrderStatus.PENDING_VERIFICATION ||
      order.status === OrderStatus.PAYMENT_DETECTED ||
      order.status === OrderStatus.CONFIRMING ||
      order.status === OrderStatus.CONFIRMED)
  ) {
    throw new ValidationError("error.cannot_cancel_after_proof");
  }

  await releaseOrderHolds(db, order, actor);
  await db.order.update({
    where: { id: orderId },
    data: {
      adminNote: `${order.adminNote ?? ""}\n[cancel] ${reason}`,
    },
  });
  await transitionOrderStatus(db, { orderId, from: order.status, to: OrderStatus.CANCELLED, meta: reason });
  logger.info(`Cancelled order ${order.orderCode} — reason: ${reason}`);
  // Raw on purpose, like the read above: callers only need the code and the
  // buyer, and a decrypt here would roll the whole cancel back over one
  // unreadable row the cancel never needed.
  return getOrderRaw(db, orderId);
}

/**
 * Add a paid-but-unfulfillable order's external payment to the buyer's
 * **credit balance** (store credit) in the order's currency, then void the
 * order. Distinct from a refund: the money never leaves the system, it becomes
 * spendable credit on a future order of the same currency.
 *
 * Amount credited = the order's external payment (`totalAmount`, i.e. the
 * amount due after any walletUsed was already deducted). The `walletUsed`
 * portion is a separate, already-spent credit and is returned by
 * `releaseOrderHolds` (reason `order_refund`); crediting `totalAmount` here
 * therefore does NOT double-count the wallet portion.
 *
 * Also accepts an order that is ALREADY CANCELLED (the expiry sweep or the
 * buyer cancelled it after a gateway payment whose delivery threw): the paid
 * amount is credited and nothing else about the order changes — see the guard
 * around `releaseOrderHolds` below. Refused with `error.order_already_refunded`
 * when such an order already has a COMPLETED refund, and with
 * `error.order_never_paid` when nothing proves a payment ever arrived for it
 * (no `delivery_failed`/`unmatched` gateway ledger row linked to it, and no
 * `binanceTxId` passed). An `underpaid` row never counts: underpaid orders
 * resolve through their own flows (see `orderHasIncomingLedgerPayment`).
 *
 * On EVERY path (not only the cancelled one) the order's linked
 * `delivery_failed`/`unmatched` rows are re-tagged `credited_to_balance` by the
 * credit itself (`consumeIncomingLedgerPayment`), so no gateway settle path can
 * reclaim and pay out the same payment again afterwards. Only the CANCELLED
 * path's success depends on finding one.
 *
 * Idempotent: a REJECTED/REFUNDED/DELIVERED order, or a pre-existing
 * `unfulfilled_credit` ledger row for this order, is refused — a
 * retry/double-tap can't double-credit. Concurrent calls for one order are
 * serialised on the order row (`FOR UPDATE`), so the loser of a double-tap reads
 * the winner's committed credit and gets `error.already_credited`. When
 * `binanceTxId` is given, that ledger row must still be actionable and unlinked
 * (or linked to this order); it is atomically re-tagged `credited_to_balance`
 * and linked to the order, and the whole credit is refused with
 * `error.transfer_already_used` otherwise, or with
 * `error.payment_currency_mismatch` for a non-USDT order.
 *
 * Audited at the route layer via `logAdminAction`.
 */
export type CreditOrderToBalanceResult = {
  credited: Decimal;
  currency: "IDR" | "USDT";
  /** The order was already CANCELLED before this call (the recovery path). */
  wasAlreadyCancelled: boolean;
  /** Gateway ledger rows this credit re-tagged `credited_to_balance`. */
  evidenceRowsConsumed: number;
};

export async function creditOrderToBalance(
  db: Db,
  args: { orderId: number; amount?: Decimal.Value; adminId: number; binanceTxId?: string | null },
): Promise<CreditOrderToBalanceResult> {
  // The order-row lock below only lasts as long as the transaction holding it,
  // so open one when handed the bare client and reuse the caller's otherwise —
  // the same rule (and the same bare-client test) as `adjustWallet`.
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  return ownsTransaction
    ? db.$transaction((tx) => creditOrderToBalanceLocked(tx, args))
    : creditOrderToBalanceLocked(db, args);
}

async function creditOrderToBalanceLocked(
  db: Db,
  args: { orderId: number; amount?: Decimal.Value; adminId: number; binanceTxId?: string | null },
): Promise<CreditOrderToBalanceResult> {
  // Hold the ORDER row for the rest of this transaction before any guard below
  // reads anything, then read the order under that lock. Two admins crediting
  // the same order at the same instant would otherwise both pass the
  // double-credit check; the (orderId, reason) unique index would still stop
  // the second credit, but as a raw constraint error rather than the clean
  // `error.already_credited`. Same lock-then-read shape as `executeRefund`
  // (./refunds), which also takes this row lock before touching the buyer's
  // wallet — so the two agree on lock order (order, then user) and a refund
  // payout and a credit on one order queue behind each other instead of both
  // reading "nothing returned yet".
  //
  // Not every caller agrees on that order: `refundUnderpaidOrder`
  // (./binance_internal) and `cancelOrder` (whose `releaseOrderHolds` locks the
  // buyer's wallet row via `adjustWallet` before `transitionOrderStatus` writes
  // the order row) both take user-then-order, so either could in principle
  // deadlock with this function on one order+buyer — `cancelOrder` more
  // plausibly now that this path accepts CANCELLED orders, since a sweep cancel
  // and an admin credit can land on the same order. Postgres detects the cycle
  // and aborts one transaction, which is the harmless direction here: nothing is
  // credited and nothing recorded, versus a buyer credited twice (same reasoning
  // as `executeRefund`'s note in ./refunds).
  await db.$queryRaw`SELECT id FROM orders WHERE id = ${args.orderId} FOR UPDATE`;
  const order = await getOrderRaw(db, args.orderId);
  if (!order) throw new ValidationError("error.order_not_found");

  // CANCELLED is deliberately absent: an already-cancelled order can still be
  // credited once (see `wasAlreadyCancelled` below).
  const terminal: string[] = [OrderStatus.REJECTED, OrderStatus.REFUNDED, OrderStatus.DELIVERED];
  if (terminal.includes(order.status)) {
    throw new ValidationError("error.order_terminal");
  }

  // Double-credit guard: bail if this order already has an unfulfilled_credit row.
  const prior = await db.walletTransaction.findFirst({
    where: { orderId: order.id, reason: "unfulfilled_credit" },
  });
  if (prior) throw new ValidationError("error.already_credited");

  // An order that arrives here already CANCELLED had its holds released and its
  // CANCELLED transition written by whatever cancelled it (`cancelOrder` runs
  // `releaseOrderHolds` too). Running either again would be wrong, not just
  // redundant: `releaseOrderHolds` would re-insert the `order_refund` wallet row
  // for `walletUsed` — rejected by `wallet_transactions`' UNIQUE(orderId, reason),
  // failing the whole credit — and would decrement the voucher's `usedCount` a
  // second time with nothing to stop it; `transitionOrderStatus` would refuse
  // CANCELLED -> CANCELLED. So both run only when THIS call is the cancel.
  const wasAlreadyCancelled = order.status === OrderStatus.CANCELLED;
  if (wasAlreadyCancelled) {
    // No unfulfilled_credit (checked above), so any remaining proof the money
    // already went back is a COMPLETED refund — crediting on top would pay the
    // buyer twice.
    const settled = await cancelledOrderIdsWithMoneyReturned(db, [order.id]);
    if (settled.has(order.id)) throw new ValidationError("error.order_already_refunded");
  }

  // A passed `binanceTxId` (POST /api/payments/credit) names the transfer this
  // credit is paid from. It is only proof of a payment while its ledger row is
  // still actionable (`unmatched`/`delivery_failed`) and unlinked or linked to
  // THIS order: a row already `matched`/`credited_to_balance`/`dismissed`/
  // `underpaid` paid for (or was ruled out for) something else, and trusting it
  // would both credit money that never arrived for this order — any abandoned,
  // never-paid CANCELLED order would do — and re-point that transfer's audit
  // trail away from the order it really belongs to. So the link is an atomic,
  // gated consume, and a miss (row gone, used, or someone else's) refuses the
  // whole credit. Binance transfers are always USDT, so a non-USDT order is
  // refused first — crediting them would book USDT figures as another currency.
  let evidenceRowsConsumed = 0;
  if (args.binanceTxId) {
    if (order.currency !== "USDT") {
      throw new ValidationError("error.payment_currency_mismatch", {
        paymentCurrency: "USDT",
        orderCurrency: order.currency,
      });
    }
    const retag = await db.processedBinanceTx.updateMany({
      where: {
        binanceTxId: args.binanceTxId,
        outcome: { in: [...ACTIONABLE_LEDGER_OUTCOMES] },
        OR: [{ orderId: null }, { orderId: order.id }],
      },
      data: { orderId: order.id, outcome: "credited_to_balance" },
    });
    if (retag.count !== 1) throw new ValidationError("error.transfer_already_used");
    evidenceRowsConsumed += retag.count;
  }

  // Consume every other gateway ledger row still linked to this order as
  // `delivery_failed`/`unmatched`, on every path: re-tag it
  // `credited_to_balance` in this same transaction. Left actionable it would
  // stay reclaimable by the gateway settle paths — a duplicate QRIS callback
  // would settle a (late-settleable) cancelled top-up again under
  // `wallet_topup`, or the amount-match poller would hand the same transfer to
  // another order — paying the money twice.
  const linkedConsumed = await consumeIncomingLedgerPayment(db, order.id);
  evidenceRowsConsumed += linkedConsumed;

  // Only an already-CANCELLED order's credit HINGES on that evidence. Nothing
  // went back (checked above) — but that is equally true of an order that was
  // never paid at all (the ordinary abandoned checkout the expiry sweep
  // cancels), and crediting that would mint balance out of nothing.
  // `order.paidAt` can't decide it: the case this path exists for — a gateway
  // payment whose delivery threw — rolled the paidAt write back with the rest
  // of the delivery transaction. What survives is the gateway ledger row,
  // claimed with this order's id before that transaction began and left
  // `delivery_failed` (or `unmatched`) — never an `underpaid` row, whose order
  // has its own resolution flow and records only part of the total — or the
  // gated `binanceTxId` consumed above. Every other creditable status keeps its
  // existing rule (an admin verified the payment by hand; gateway evidence was
  // never required), so there a zero count is simply nothing to close out.
  if (wasAlreadyCancelled && evidenceRowsConsumed === 0) {
    throw new ValidationError("error.order_never_paid");
  }

  const currency: "IDR" | "USDT" = order.currency === "USDT" ? "USDT" : "IDR";
  const amount = q4(Decimal.max(ZERO, new Decimal(args.amount ?? order.totalAmount)));

  // One timestamp for both money events this function records (the credit and
  // the hold release), so the two postings share the occurredAt of the single
  // admin action that caused them rather than two clock reads a few
  // milliseconds apart.
  const now = new Date();

  if (amount.greaterThan(0)) {
    const { transactionId } = await adjustWallet(db, order.userId, amount, {
      currency,
      reason: "unfulfilled_credit",
      orderId: order.id,
      adminId: args.adminId,
    });
    // The buyer's external payment becoming wallet credit. Whether this reverses
    // recognised revenue or recognises the payment for the first time depends on
    // whether this order ever settled — `canCredit` covers PENDING_VERIFICATION
    // and UNDERPAID (never settled) as well as PROCESSING (settled), so the
    // posting asks the ledger instead of assuming either.
    await postOrderWalletCreditPosting(db, {
      walletTransactionId: transactionId,
      orderId: order.id,
      orderCode: order.orderCode,
      occurredAt: now,
    });
  }

  // Release held stock + return the already-spent walletUsed (in order currency)
  // + roll back voucher usage. Distinct money from the paid amount credited above,
  // and separately posted (or not) by releaseOrderHolds itself. Skipped for an
  // order that was already CANCELLED — its cancel already did this once.
  if (!wasAlreadyCancelled) {
    await releaseOrderHolds(db, order, { type: StockActorType.ADMIN, adminId: args.adminId }, now);
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      adminNote: `${order.adminNote ?? ""}\n[credit_to_balance] ${amount.toString()} ${currency} by admin_id=${args.adminId}`,
    },
  });
  if (!wasAlreadyCancelled) {
    await transitionOrderStatus(db, {
      orderId: order.id,
      from: order.status,
      to: OrderStatus.CANCELLED,
      meta: `credit_to_balance by admin_id=${args.adminId}`,
    });
  }

  logger.info(
    `Credited order ${order.orderCode} (${amount.toString()} ${currency}) to buyer's credit balance — approved by admin ${args.adminId}`,
  );
  return { credited: amount, currency, wasAlreadyCancelled, evidenceRowsConsumed };
}

export async function rejectOrder(
  db: Db,
  orderId: number,
  args: { adminId: number; reason: string },
) {
  const order = await getOrderRaw(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  // PROCESSING = a paid manual/manual_with_info order awaiting hand-fulfilment
  // (settlePaidOrder's manual branch) — legal per LEGAL_TRANSITIONS so an admin
  // who can't actually source the item has a way to reject/refund it instead
  // of being stuck with only "Send to Buyer" (audit-per-sku-delivery-flows-
  // 2026-07-13.md finding #2). It never reserves stock (fulfillManualOrder:
  // "No stock is touched"), so releaseOrderHolds's stock-release loop below
  // naturally no-ops for it — same walletUsed/voucher rollback applies as for
  // a PENDING_VERIFICATION reject.
  const rejectable: string[] = [OrderStatus.PENDING_VERIFICATION, OrderStatus.PROCESSING];
  if (!rejectable.includes(order.status)) {
    throw new ValidationError("error.order_not_pending_verification");
  }
  // H-2 (backend audit, 2026-07-31): a PROCESSING order reaches here already
  // paid (settlePaidOrder stamped paidAt) — rejecting it directly would
  // strand that payment at the terminal REJECTED state forever. Send the
  // admin to "Credit to Balance" (creditOrderToBalance, now that canCredit
  // covers PROCESSING too) instead.
  await assertNotPaidWithoutCredit(db, order);

  await releaseOrderHolds(db, order, { type: StockActorType.ADMIN, adminId: args.adminId });
  await db.order.update({
    where: { id: orderId },
    data: {
      rejectionReason: args.reason,
      adminNote: `${order.adminNote ?? ""}\n[reject] by admin_id=${args.adminId}: ${args.reason}`,
    },
  });
  await transitionOrderStatus(db, {
    orderId,
    from: order.status,
    to: OrderStatus.REJECTED,
    meta: `by admin_id=${args.adminId}: ${args.reason}`,
  });
  logger.info(`Rejected order ${order.orderCode} by admin ${args.adminId} — reason: ${args.reason}`);
  // Raw for the same reason as cancelOrder's return.
  return getOrderRaw(db, orderId);
}

/**
 * Admin approves a pending order: allocate/flip stock → SOLD, mark DELIVERED,
 * pay referral commission, enqueue the testimoni outbox row (same tx), and
 * return the credentials to DM the buyer.
 *
 * Refuses a WALLET_TOPUP order outright (Task E5 item 3). This is the mirror
 * image of the guard `settleWalletTopup` (crud/wallet_topup.ts) already puts
 * on its own door, and it exists for the same reason: this is the single
 * chokepoint into DELIVERED, and a top-up reaching it would pass the atomic
 * claim, iterate zero items (a top-up order has no line items), allocate no
 * stock, and land in DELIVERED having credited the buyer NOTHING — their money
 * taken and silently converted into a delivered order with nothing in it.
 * Nothing routes a top-up here today; the guard is what stops a future caller
 * from being the first, because the failure is silent and about money.
 */
export async function approveOrder(
  db: Db,
  orderId: number,
  args: { adminId: number },
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }> {
  // Raw: nothing before the delivery loop needs a secret, and the loop
  // decrypts each row itself from the row it has just sold (and throws there,
  // rolling the approval back, if that row is unreadable).
  const order = await getOrderRaw(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.kind === OrderKind.WALLET_TOPUP) {
    throw new ValidationError("error.order_is_wallet_topup");
  }

  // Atomic conditional claim: only ONE caller can flip PENDING_VERIFICATION ->
  // DELIVERED for this order, regardless of DB isolation level — a single
  // UPDATE's row-level atomicity holds even under Read Committed, unlike the
  // read-then-throw check this replaces (which was only safe if concurrent
  // transactions happened to serialize). Making the guard explicit removes that
  // implicit dependency (Bot-2 fix, security
  // audit 2026-06-23). If the rest of this function throws (e.g. out of
  // stock below), the whole $transaction the caller wraps this in rolls back
  // — including this claim — so behavior on failure is unchanged.
  const now = new Date();
  const claim = await db.order.updateMany({
    where: { id: orderId, status: OrderStatus.PENDING_VERIFICATION },
    data: { status: OrderStatus.DELIVERED, paidAt: now, deliveredAt: now },
  });
  if (claim.count !== 1) {
    throw new ValidationError("error.order_not_pending_verification");
  }
  // This is the one call site that does NOT route through
  // transitionOrderStatus() — see that function's doc-comment for why
  // (the updateMany above IS the concurrency-safety claim for this exact
  // race, and re-validating it through a generic helper would reintroduce
  // the race rather than guard it). Still write the same audit-trail row a
  // routed transition would, right after the claim succeeds.
  await db.orderStatusHistory.create({
    data: { orderId, status: OrderStatus.DELIVERED, meta: `approved by admin_id=${args.adminId}` },
  });

  // Per-item shadow of the claim above (Trustance Phase 1, Task 3). Placed
  // HERE, immediately behind the atomic claim, rather than in settlePaidOrder's
  // AUTO branch, for two reasons: it lands inside the same transaction as the
  // order-level DELIVERED write (so the two can never diverge, and a throw
  // below — e.g. out of stock — rolls both back together), and it covers the
  // callers that reach approveOrder without going through settlePaidOrder.
  //
  // Every item, one value: this function delivers the order as a whole, so a
  // split outcome is not representable here. Making items resolve
  // independently is a later plan's job — see OrderItem.status in
  // schema.prisma.
  await db.orderItem.updateMany({
    where: { orderId },
    data: { status: OrderItemStatus.DELIVERED },
  });

  // adminId 0 is not a user id — it is how the auto-confirm pollers and the
  // wallet-checkout path say "no human approved this" (see the audit-row
  // branch further down). The stock ledger records that honestly as SYSTEM
  // rather than inventing admin 0.
  const actor: StockEventActor =
    args.adminId === 0
      ? { type: StockActorType.SYSTEM }
      : { type: StockActorType.ADMIN, adminId: args.adminId };

  const credentials: string[] = [];

  for (const item of order.items) {
    // Warranty runs from the sale, using the days frozen onto the line at
    // checkout. Zero days means the SKU carries no warranty, so leave the
    // column null rather than stamping an already-expired instant.
    const warrantyDays = Number(item.warrantyDaysSnapshot ?? 0);
    const soldData = {
      status: StockStatus.SOLD,
      soldAt: now,
      soldToOrderId: order.id,
      soldToOrderItemId: item.id,
      warrantyUntil: warrantyDays > 0 ? addDays(now, warrantyDays) : null,
    };
    // Flip a row to SOLD only if THIS order still holds it. `order` is a
    // snapshot read before the claim above, and the reserved row can have
    // moved on since: an admin's markStockDead locks the RESERVED row, sets it
    // DEAD and commits in between. An unconditional update off the snapshot
    // would overwrite that DEAD with SOLD and hand the buyer a credential the
    // admin had just declared dead. Postgres re-checks this WHERE against the
    // committed row after waiting out any lock on it, so a row that died in
    // the meantime matches nothing and the line falls through to substitution
    // below, exactly as if it had died before approve read the order.
    const sellIfStillHeld = async (stockId: number): Promise<boolean> => {
      const res = await db.stockItem.updateMany({
        where: { id: stockId, status: StockStatus.RESERVED, orderId: order.id, deletedAt: null },
        data: soldData,
      });
      return res.count === 1;
    };

    const stock = item.stockItem;
    let soldId: number | null =
      stock !== null && stock.status === StockStatus.RESERVED && (await sellIfStillHeld(stock.id)) ? stock.id : null;
    if (soldId === null) {
      const substitutedOut = stock;
      const replacement = await allocateOneAvailableStock(db, item.productId, order.id, actor, item.id);
      if (!replacement) {
        throw new ValidationError("error.cannot_deliver_out_of_stock", {
          product: item.product.name,
        });
      }
      await db.orderItem.update({
        where: { id: item.id },
        data: { stockItemId: replacement.id },
      });
      // The pair of events records the swap itself; neither row changes
      // status because of it (the replacement's own AVAILABLE → RESERVED is
      // already on its ledger, written by the allocation above), so both
      // status columns stay null. `replacesStockItemId` is deliberately NOT
      // set — that column carries warranty-replacement semantics (Fase 5e),
      // not "the row originally reserved for this line went bad".
      if (substitutedOut) {
        await recordStockEvent(db, {
          stockItemId: substitutedOut.id,
          eventType: StockEventType.SUBSTITUTED_OUT,
          orderId: order.id,
          orderItemId: item.id,
          actor,
        });
      }
      await recordStockEvent(db, {
        stockItemId: replacement.id,
        eventType: StockEventType.SUBSTITUTED_IN,
        orderId: order.id,
        orderItemId: item.id,
        actor,
      });
      // The replacement was reserved for this order inside this same
      // transaction, so its row lock is ours until commit and this cannot
      // lose — but a miss would mean selling a row we don't hold, so it is
      // checked rather than assumed.
      if (!(await sellIfStillHeld(replacement.id))) throw new Error(`Stock item ${replacement.id} was reserved for order ${order.id} but could not be marked sold.`);
      soldId = replacement.id;
    }
    // Decrypt from the row as it is now, after the SOLD flip has locked it —
    // never from the pre-claim snapshot. Throws on an unreadable credential,
    // which rolls the whole approval back: a buyer must never be sent
    // ciphertext or a placeholder.
    const soldRow = await db.stockItem.findUniqueOrThrow({ where: { id: soldId }, select: { credentials: true } });
    const credential = decryptStockCredentials(soldRow.credentials, soldId);
    await recordStockEvent(db, {
      stockItemId: soldId,
      eventType: StockEventType.SOLD,
      fromStatus: StockStatus.RESERVED,
      toStatus: StockStatus.SOLD,
      orderId: order.id,
      orderItemId: item.id,
      actor,
    });
    credentials.push(credential);
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      adminNote: `${order.adminNote ?? ""}\n[approve] by admin_id=${args.adminId}`,
    },
  });

  // adminId=0 means this approval came from an auto-confirm poller, not a
  // human admin tapping Approve — those callers (verification.ts, web-admin's
  // /orders/:id/approve) already write their own logAdminAction row with the
  // real admin id, so logging here too would duplicate it. The auto-deliver
  // path had NO audit trail at all before this (Checkout-6 fix, security
  // audit 2026-06-23) — the paid->delivered, stock->SOLD transition is exactly
  // where a "paid but never got my item" dispute needs forensic evidence.
  if (args.adminId === 0) {
    await logAdminAction(db, {
      adminId: null,
      action: "order.auto_deliver",
      targetType: "order",
      targetId: order.id,
      details: `Auto-delivered order ${order.orderCode}.`,
    });
  }

  // Referral + testimonial — shared with the manual-delivery path so both pay
  // the referee's commission and post the same channel testimonial.
  await finalizeDeliverySideEffects(db, order, now);

  // Recognise the order's revenue in the double-entry ledger. `now` is the same
  // timestamp the atomic claim above stamped as `paidAt`, so the posting's
  // `occurredAt` is the order's real payment time and not a second clock read.
  //
  // Placed after delivery rather than before it because a posting must never be
  // what stops a paid buyer getting their goods: by here the order is already
  // DELIVERED and its stock SOLD. `settlePaidOrder`'s AUTO branch reaches this
  // through its call to this function, so it needs no posting of its own — only
  // the MANUAL branch does.
  await postOrderPaymentPosting(db, order, now);

  logger.info(`Approved and delivered order ${order.orderCode} by admin ${args.adminId}`);
  const refreshed = await getOrder(db, order.id);
  return { order: refreshed!, credentials };
}

/**
 * The buyer label carried by the ORDER_DELIVERED channel post
 * (`masked_buyer_id`). That post goes to the shop's PUBLIC/semi-public
 * testimonial channel, not to a private admin chat, so the label has to
 * satisfy two conflicting requirements at once: it must never let a reader
 * identify or contact the buyer, and it must still differ between buyers, or
 * the channel feed reads as though one person bought everything.
 *
 * Per buyer kind:
 * - **Telegram buyer** — first 4 digits of the Telegram id, the rest replaced
 *   by X (minimum 3). Unchanged.
 * - **Registered web buyer** — "WEB-XXX". Also unchanged: the previous inline
 *   version built `"WEB-" + loginUsername.slice(0, 2)` and then cut the result
 *   back to its first 4 characters ("WEB-") before padding, so the login-name
 *   characters provably never reached the channel. The parameter is still
 *   accepted so the buyer-kind branching reads completely at the call site.
 * - **Guest buyer** — has no username at all, so before this the label was
 *   always the constant "WEB-XXX" and the whole feed read as one shopper.
 *   The hint is the last 2 digits of the guest's `User.id`, zero-padded.
 *
 *   The first version of this took the hint from the first 2 characters of
 *   the guest email's local part. That met the "tell buyers apart" goal but
 *   published 2 characters of a private address to a public channel — and
 *   stored them in `notification_outbox` rows besides. The row id reaches the
 *   same goal from something that is not a secret: it is an opaque internal
 *   counter, it is not contactable, it is not attacker-supplied, and it says
 *   nothing about who the buyer is. Only the LAST two digits, so the label
 *   does not even disclose the id itself, and ids 100 apart deliberately
 *   collide into one label.
 */
export function channelMaskedBuyerId(user: {
  id: number;
  telegramId: bigint | number | string | null;
  loginUsername: string | null;
  isGuest?: boolean;
}): string {
  if (user.telegramId != null) {
    const rawId = String(user.telegramId);
    return rawId.slice(0, 4) + "X".repeat(Math.max(rawId.length - 4, 3));
  }
  // A registered web buyer falls through with an empty hint and keeps the
  // exact "WEB-XXX" label it has always had.
  const hint = user.isGuest ? String(user.id).slice(-2).padStart(2, "0") : "";
  return `WEB-${hint}XXX`;
}

/**
 * Human-readable "who bought this" label for admin surfaces that render
 * plain text rather than the Orders/Order Detail pages' badge + email
 * layout — currently the orders CSV export. A guest buyer's `fullName`,
 * `username`, and `loginUsername` are all always null (only `guestEmail`
 * identifies them), so the old inline `fullName ?? username ?? loginUsername
 * ?? ""` fallback silently emitted a blank Customer cell for every guest
 * order — the same "unexplained blank surface" defect the admin pages were
 * fixed for. Unlike `channelMaskedBuyerId`, this is for an
 * authenticated-admin-only surface, not a public channel post, so the full
 * email is safe to show here.
 */
export function customerLabel(
  user: {
    fullName: string | null;
    username: string | null;
    loginUsername: string | null;
    isGuest?: boolean;
    guestEmail?: string | null;
  } | null,
): string {
  if (!user) return "";
  if (user.isGuest) {
    return user.guestEmail ? `Guest (${user.guestEmail})` : "Guest (no contact email)";
  }
  return user.fullName ?? user.username ?? user.loginUsername ?? "";
}

/**
 * Convert a central-IDR amount into the order's own settlement currency.
 *
 * `subtotalAmount`/`discountAmount`/`item.unitPrice` are always stored in
 * central-IDR (see createOrderFromCart/createOrderDirect) regardless of the
 * order's settlement currency — only `totalAmount` is converted by
 * `finalizeOrderPayment`. Without this, a notification would render a raw IDR
 * figure with a USDT suffix (e.g. "8000 USDT" for a Rp8000 order instead of
 * "0.40 USDT").
 *
 * Each DISPLAYED figure is converted once, from its own pre-conversion
 * central-IDR value — the same technique
 * apps/web-admin/src/routes/orderMoneyView.ts's `toOrderCurrency` uses for the
 * admin order-detail view. "Once per displayed figure" is the load-bearing
 * half of `usdtFromIdr`'s own rule and callers must honour it: never feed a
 * value that has ALREADY been through here back into further arithmetic (an
 * item's line total, for instance, multiplies unit x quantity in IDR and
 * converts the product — see enqueueBuyerOrderReadyEmailIfGuest — rather than
 * scaling the rounded per-unit figure, which would scale its rounding error
 * too).
 *
 * BEWARE THE OTHER HALF OF THAT RULE: separately-rounded figures need not
 * reconcile with each other. Two values that each went through here are each
 * rounded UP to the next 0.01 USDT on their own, so their difference can be up
 * to ~0.01 USDT away from the converted difference (L-1 in
 * docs/archive/audit-backend-2026-07-31.md flags this for orderMoneyView.ts). A caller
 * whose figures a reader will ADD UP therefore cannot convert each of them
 * here and hope: it must convert ONE and derive the rest from figures already
 * in the settlement currency, which is what enqueueBuyerOrderReadyEmailIfGuest
 * does for the buyer's receipt.
 *
 * The owner paid email and admin order page use `reconciledOrderMoneyRows`
 * for their additive summaries: all bulk/voucher/wallet/marker rows reconcile
 * with the exact settled total. This converter is retained only for an item's
 * indicative unit price and the buyer receipt's existing derivation. A unit
 * price rounded for display is not the additive subtotal; quantity must not
 * multiply its conversion error into the summary.
 */
function orderCurrencyConverter(order: { currency: string; fxRate: Decimal | null }) {
  return (value: Decimal.Value): Decimal =>
    order.currency === "IDR" || !order.fxRate ? new Decimal(value) : usdtFromIdr(value, order.fxRate);
}

/**
 * The storefront origin buyer-facing links are built from, with any trailing
 * slashes stripped, or null when neither URL is configured. `SHOP_PUBLIC_URL
 * ?? PUBLIC_URL` is the same base every other buyer-facing link in this
 * codebase uses — deliberately NOT `ADMIN_PUBLIC_URL`, which the owner-email
 * "View Order" link uses, because that origin is frequently private and means
 * nothing to a customer.
 */
function storefrontBase(): string | null {
  const base = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

/**
 * Enqueue the guest buyer's "your order is ready" email — or nothing, for
 * anyone who isn't a guest with a contact address.
 *
 * ONE function called from BOTH points an order actually becomes ready
 * (`settlePaidOrder`'s AUTO branch and `fulfillManualOrder`) so the guard and
 * the payload can never drift between them. Two call sites are required, not
 * one: a MANUAL SKU never passes through the AUTO branch — it goes to
 * PROCESSING at settle time and only finishes later in `fulfillManualOrder` —
 * so an AUTO-only call site would silently send a guest who bought a manual
 * SKU nothing at all.
 *
 * THE GUARD IS `isGuest && guestEmail`, and it is narrow on purpose.
 * Registered buyers get their notifications by Telegram DM; a registered buyer
 * with no Telegram gets nothing today, which is a known gap deliberately left
 * open (widening it is a matter of relaxing this one condition, but that is
 * out of scope here). A guest with no `guestEmail` has nowhere to receive it.
 *
 * RETURNS WHETHER IT ACTUALLY ENQUEUED ANYTHING, so a caller that has to tell
 * an admin whether the buyer was reached can know rather than assume. The
 * delivery call sites above ignore it — for them "guest or not" is not a
 * decision, it is just the shape of the buyer — but the stock-replacement
 * service (crud/stockReplacement.ts) reports the answer in its audit line, and
 * it must be THIS function's guard that decides it rather than a second copy of
 * the condition that could drift away from this one.
 *
 * NO CREDENTIALS CROSS THIS BOUNDARY. Note what is NOT read off `order` here:
 * `deliveredContent`, the admin-typed manual content, and the stock items'
 * credentials. Email is unencrypted and permanent, and the outbox payload is
 * additionally visible in the admin `/outbox` panel — the buyer reads what
 * they bought on the order page, which is exactly what this email links to.
 */
export async function enqueueBuyerOrderReadyEmailIfGuest(
  db: Db,
  order: OrderWithIncludes,
): Promise<boolean> {
  if (!order.user.isGuest || !order.user.guestEmail) return false;

  const toOrderCurrency = orderCurrencyConverter(order);
  const base = storefrontBase();

  // ── The four figures the buyer reads stacked on top of each other ───────
  //
  // They have to RECONCILE — Subtotal - Discount + Unique code = Total,
  // exactly — because the reader is the customer who just paid, and a summary
  // that does not add up reads as an overcharge and becomes a support ticket.
  //
  // Two facts make that achievable rather than lucky. First, `totalAmount` and
  // `uniqueCents` are both stored exactly in the settlement currency, so
  // `totalAmount - uniqueCents` IS `usdtFromIdr(baseIdr, fxRate)` — the single
  // conversion finalizeOrderPayment already performed, recovered without
  // rounding anything again. Second, converting a figure through
  // `toOrderCurrency` rounds it, so two independently converted figures
  // subtracted from each other need not land on the conversion of their
  // difference — `round(a) - round(b)` is simply not `round(a - b)`, under any
  // rounding rule. The original worked example was from the 0.1-half-up era
  // (Rp45.000 with a Rp9.000 voucher at an fxRate of 16.000 printed 2.8 - 0.6 =
  // 2.2 beside a net of 2.3, a receipt contradicting itself by 0.1 USDT). M13's
  // 0.01-ceil step shrinks the worst case to 0.01 but does not remove it:
  // Rp32.080 with a Rp16.016 voucher converts to a 2.01 subtotal, a 1.01
  // independently-converted discount and a 1.01 net — and 2.01 - 1.01 is 1.00,
  // not 1.01. A smaller contradiction is still a contradiction to the customer
  // reading it, so the derivation below stays exactly as it was.
  //
  // So convert exactly ONE figure and derive the rest. The SUBTOTAL is the
  // anchor: it sits directly beneath the item lines, which are themselves
  // converted from central IDR, so it is the figure a reader cross-checks
  // against something else on the page. The discount is the derived one — it
  // is an adjustment rather than a quantity, it already has a hide-when-zero
  // convention, and being off by up to 0.01 USDT from its own converted value
  // is the cheapest place on the page to absorb the rounding.
  //
  // `Decimal.max` is defensive, not load-bearing: `usdtFromIdr` is monotonic
  // and `baseIdr` can never exceed `subtotalAmount`, so the derived discount
  // is already non-negative for every order that reaches here. Deriving the
  // subtotal back from it (rather than reusing the converted value) keeps the
  // identity exact even if that ever stopped holding.
  const uniqueCents = new Decimal(order.uniqueCents);
  const netInOrderCurrency = new Decimal(order.totalAmount).minus(uniqueCents);
  // Derived for IDR orders too, even though they convert nothing and so have
  // no rounding to reconcile. The identity still needs the derivation for a
  // second, independent reason: `order.discountAmount` is the VOUCHER discount
  // alone, while `bulkDiscountAmount` reduces the total just as much (see
  // `afterDiscount` in createOrderFromCart, ~line 477). Printing
  // `discountAmount` verbatim therefore dropped every bulk discount off the
  // page — a 10-unit order at Rp100.000 with Rp10.000 of bulk pricing printed
  // a Rp100.000 subtotal, no discount row at all, and a Rp90.000 total.
  // Subtracting the net from the subtotal recovers every reduction at once, so
  // the printed figures reconcile whatever combination of bulk, voucher and
  // wallet credit produced them.
  const discount = Decimal.max(ZERO, toOrderCurrency(order.subtotalAmount).minus(netInOrderCurrency));
  const subtotal = netInOrderCurrency.plus(discount);

  // The longest warranty covering anything in the order. Orders are
  // homogeneous in practice (one SKU per order), so this is the order's
  // warranty; `max` just keeps it honest if that ever stops being true.
  const warrantyDays = order.items.length
    ? Math.max(...order.items.map((item) => item.warrantyDaysSnapshot))
    : null;

  await enqueueBuyerOrderReadyEmail(db, {
    orderId: order.id,
    orderCode: order.orderCode,
    to: order.user.guestEmail,
    items: order.items.map((item) => ({
      name: item.product.name,
      variant: item.product.durationLabel,
      quantity: item.quantity,
      unitPrice: toOrderCurrency(item.unitPrice),
      // Multiply in central IDR, then convert the PRODUCT once — never
      // `unitPrice * quantity` on the already-converted figure above. On a
      // USDT order that figure has been rounded UP to the next 0.01, and
      // scaling it scales the rounding error with it: 5 x Rp8.900 at an
      // fxRate of 16.000 gives a unit price of 0.55625 -> 0.56, so the naive
      // product prints "5 x 0.56 = 2.80 USDT" directly above a Subtotal of
      // 44.500/16.000 = 2.78125 -> 2.79 USDT. This is `usdtFromIdr`'s own
      // "convert once per displayed figure, never per component" rule, and
      // the receipt's reader is the paying customer. (The gap shrank with
      // M13's rounding step — it was 3.00 against 2.80 — but every extra unit
      // widens it again, and ceiling makes it always favour the shop, which is
      // the version a customer complains about.)
      lineTotal: toOrderCurrency(new Decimal(item.unitPrice).times(item.quantity)),
    })),
    subtotal,
    discount,
    // Stored in the settlement currency already, and printed as its own row:
    // it is money the buyer transferred, and while it went unprinted the
    // receipt could not add up however carefully the rest was rounded.
    uniqueCents,
    // Already in the order's settlement currency — finalizeOrderPayment
    // converts this one, so it must NOT go through toOrderCurrency again.
    total: order.totalAmount,
    currency: order.currency,
    warrantyDays,
    // Null when the shop has no public URL configured; the email template
    // then renders no button and leans on the printed order code and the
    // /track link instead. Same treatment ADMIN_PUBLIC_URL gets for the
    // owner email's "View Order" link.
    orderUrl: base ? `${base}/checkout/${order.orderCode}/pay` : null,
    // The order-code recovery page. A guest whose 30-day session cookie has
    // expired, or who opens this mail on another device, cannot use the
    // button above — /account/orders and the pay page are session-gated and
    // bounce them to a login they have no password for. /track trades the
    // order code back for a session and is their only way in.
    trackUrl: base ? `${base}/track` : null,
  });
  return true;
}

/**
 * The "Total" a public channel post shows for a delivered order: what the
 * order was worth in its own currency (B8, money audit). `totalAmount` alone
 * is what was left to COLLECT — 0 for a wallet-paid order, net of any partial
 * credit — and on a USDT order it also carries the unique-cents matching noise
 * (0.4766 for a 0.97 USDT order with 0.5 paid from credit). So: total plus the
 * wallet credit (stored in the same settlement currency), minus the unique
 * cents, printed in whole rupiah for IDR and 2 decimals for USDT.
 */
function publicPostTotal(order: {
  currency: string;
  totalAmount: Decimal.Value;
  walletUsed: Decimal.Value;
  uniqueCents: Decimal.Value;
}): string {
  const gross = Decimal.max(
    ZERO,
    new Decimal(order.totalAmount).plus(order.walletUsed).minus(order.uniqueCents),
  );
  return order.currency === OrderCurrency.IDR ? quantizeMoney(gross, 0).toFixed(0) : quantizeMoney(gross, 2).toFixed(2);
}

/**
 * Post-delivery side effects shared by the AUTO path (approveOrder) and the
 * MANUAL path (fulfillManualOrder): pay the referee's referral commission and
 * enqueue the public-channel testimonial. Runs AFTER the atomic DELIVERED claim
 * in both callers, so a lost race can't reach it twice (referral is itself
 * gated on "referee's first delivered order").
 */
export async function finalizeDeliverySideEffects(
  db: Db,
  order: OrderWithIncludes,
  now: Date,
): Promise<void> {
  // Referral commission (referee's first delivered order only). Currency +
  // fxRate ride along so IDR orders convert to the USDT wallet basis.
  await maybePayReferralCommission(
    db,
    {
      id: order.id,
      userId: order.userId,
      orderCode: order.orderCode,
      totalAmount: order.totalAmount,
      currency: order.currency,
      fxRate: order.fxRate,
    },
    now,
  );

  // Enqueue testimoni notification in the same transaction as the status flip
  // — but only when a testimonial channel is actually configured. Without
  // PUBLIC_CHANNEL_ID the dispatcher just releases this row back to PENDING
  // forever (see dispatcher.ts), so skip creating it rather than leaving a
  // dead "Waiting" row behind for every delivered order.
  if (publicChannelId() !== undefined) {
    // Web-only buyers (telegramId=null) get a "WEB-…" masked id and the
    // via_website flag so the admin channel post shows the origin.
    const viaWebsite = order.user.telegramId == null;
    const maskedBuyerId = channelMaskedBuyerId(order.user);
    const itemsSummary = order.items.map((item) => ({
      name: item.product.name,
      duration: item.product.durationLabel,
      qty: item.quantity,
    }));
    await enqueueNotification(db, NotificationEvent.ORDER_DELIVERED, order.id, {
      order_code: order.orderCode,
      masked_buyer_id: maskedBuyerId,
      items: itemsSummary,
      total: publicPostTotal(order),
      // The order's own transaction currency (IDR via TokoPay / USDT via
      // Binance), not the legacy global CURRENCY env.
      currency: order.currency,
      delivered_at: utcStamp(now),
      buyer_language: langCode(order.user.language),
      via_website: viaWebsite,
    });
  }

  await maybeEnqueueBulkPurchaseBroadcast(db, order);
}

/**
 * Post a "someone just bought a lot of X" channel announcement when a single
 * denomination's quantity within this order crosses the admin-configured
 * threshold. Off by default (bulk_purchase_broadcast_enabled unset/"false"),
 * and — like the ORDER_DELIVERED testimonial above — skipped entirely rather
 * than enqueued when no channel is configured, so it doesn't leave a dead
 * PENDING row behind.
 */
async function maybeEnqueueBulkPurchaseBroadcast(db: Db, order: OrderWithIncludes): Promise<void> {
  const enabled = (await getSetting(db, "bulk_purchase_broadcast_enabled")) === "true";
  if (!enabled) return;
  if (publicChannelId() === undefined) return;

  const threshold = Number.parseInt((await getSetting(db, "bulk_purchase_broadcast_threshold")) ?? "", 10);
  if (!Number.isFinite(threshold) || threshold < 2) return;

  const qtyByDenominationId = new Map<number, number>();
  for (const item of order.items) {
    qtyByDenominationId.set(item.productId, (qtyByDenominationId.get(item.productId) ?? 0) + item.quantity);
  }
  const qualifyingIds = [...qtyByDenominationId.entries()]
    .filter(([, qty]) => qty >= threshold)
    .map(([id]) => id);
  if (!qualifyingIds.length) return;

  const denominations = await db.denomination.findMany({
    where: { id: { in: qualifyingIds } },
    include: { product: true },
  });
  const template = (await getSetting(db, "bulk_purchase_broadcast_template")) || DEFAULT_BULK_BROADCAST_TEMPLATE;

  for (const denom of denominations) {
    const qty = qtyByDenominationId.get(denom.id)!;
    await enqueueNotification(db, NotificationEvent.BULK_PURCHASE_BROADCAST, order.id, {
      product_name: denom.product.name,
      denomination_name: denom.name,
      qty,
      template,
    });
    logger.info(
      `Order ${order.orderCode} purchased ${qty} of ${denom.product.name} - ${denom.name} in one order, crossing the bulk-purchase broadcast threshold (${threshold}) — queued a channel announcement.`,
    );
  }
}

/**
 * Bring `Order.status` into agreement with the statuses of its `OrderItem`
 * rows (Trustance Phase 1, Task 3).
 *
 * ## Today this provably does nothing
 *
 * Call it and it returns `null` — every time, for every order this codebase can
 * create. That is not an accident, it is the acceptance criterion for the task
 * that added it. The cart composition rule (@app/core/cartComposition) keeps
 * every order homogeneous; `settlePaidOrder`, `approveOrder` and
 * `fulfillManualOrder` each write one status to every item of an order in the
 * same transaction as the order-level status write; so the derived status is
 * always the status the order already has, which
 * `deriveOrderStatusFromItems` reports as "nothing to change".
 * `orderItemStatus.test.ts` (packages/db/src/crud) asserts exactly this for
 * every order shape, including that PARTIALLY_DELIVERED never comes out.
 *
 * It is wired into `settlePaidOrder` and `fulfillManualOrder` anyway, at the
 * points where those functions have just written a status, so the no-op is
 * continuously exercised rather than merely asserted once — if a future change
 * ever makes items disagree with their order, that shows up here immediately
 * instead of at the next audit.
 *
 * ## When it does start doing something
 *
 * A later plan loosens cart mixing so lines resolve independently; at that
 * point a genuinely split order becomes representable and this is what folds
 * the per-line outcomes back into one order-level status, including
 * PARTIALLY_DELIVERED.
 *
 * ## Deliberate safety properties
 *
 * - It goes through `transitionOrderStatus`, so it inherits the legality table
 *   and the atomic claim; it can never overwrite an order that moved on
 *   underneath it, and it can never invent a structurally impossible move.
 * - A derivation it is not sure about is not a derivation: a legacy null item
 *   status, an item still in flight, or an order with no items all yield
 *   `null`. See `deriveOrderStatusFromItems`.
 * - A lost race is benign (another writer got there first), so this uses the
 *   `try` variant and reports the outcome rather than throwing into a caller
 *   whose real work already succeeded.
 *
 * @returns the status it wrote, or `null` when it left the order alone.
 */
export async function recomputeOrderStatus(db: Db, orderId: number): Promise<string | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderCode: true, status: true, items: { select: { status: true } } },
  });
  if (!order) return null;

  const derived = deriveOrderStatusFromItems(
    order.items.map((it) => it.status),
    order.status,
  );
  if (derived === null) return null;

  // Reaching here today means an item's status disagrees with its order's,
  // which the invariants above say cannot happen — so say so loudly rather
  // than silently repairing it and losing the evidence.
  logger.warn(
    `Order ${order.orderCode} had a status (${order.status}) that disagreed with the outcomes recorded on its own line items, ` +
      `which is not supposed to be reachable yet — recomputing it to ${derived}. ` +
      `Something wrote OrderItem.status without writing the matching Order.status in the same transaction; ` +
      `check the most recent change to settlePaidOrder/approveOrder/fulfillManualOrder.`,
  );
  const applied = await tryTransitionOrderStatus(db, {
    orderId,
    from: order.status,
    to: derived,
    meta: "recomputed from line-item outcomes",
  });
  return applied ? derived : null;
}

/**
 * Payment-confirmation entry point — the single place the auto-vs-manual
 * delivery branch lives. Every payment rail (and the human-admin approve
 * actions) call this instead of approveOrder directly, and send credentials
 * only when the result kind is "delivered".
 *
 * - AUTO SKU  → approveOrder (pull stock, fill template, DELIVERED) — unchanged.
 * - MANUAL / MANUAL_WITH_INFO SKU → move PENDING_VERIFICATION → PROCESSING (no
 *   stock), enqueue the buyer's "being prepared" DM, and leave the order in the
 *   admin fulfilment queue (drained later by fulfillManualOrder).
 *
 * The order must already be at PENDING_VERIFICATION (callers do the
 * PENDING_PAYMENT → PENDING_VERIFICATION transition first, exactly as before).
 *
 * Trustance Phase 1 Task 3 added per-item `OrderItem.status` writes inside each
 * branch. It did NOT change which branch runs: the order-wide `isManual`
 * boolean below is untouched, and the item statuses are a shadow of whichever
 * branch it selects, never an input to it.
 */
export type SettleResult =
  | { kind: "delivered"; order: OrderWithIncludes; credentials: string[] }
  | { kind: "processing"; order: OrderWithIncludes; credentials: [] };

export async function settlePaidOrder(
  db: Db,
  orderId: number,
  args: { adminId: number },
): Promise<SettleResult> {
  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  // Refuse a WALLET_TOPUP before the branch split below (Task E5 item 3).
  // `approveOrder` carries the authoritative guard — it is the chokepoint into
  // DELIVERED — but rejecting here as well means a gateway that called the
  // wrong settlement helper fails before either branch runs and before either
  // owner email is enqueued, and names the entry point it actually used.
  // Note the AUTO branch is the one a top-up would take: `isManual` reads
  // `order.items`, and a top-up order has none, so `.some()` is false. That is
  // a second implicit argument this guard makes unnecessary to trust.
  if (order.kind === OrderKind.WALLET_TOPUP) {
    throw new ValidationError("error.order_is_wallet_topup");
  }

  // Orders are homogeneous (the storefront cart blocks mixing delivery types,
  // and the bot orders one SKU at a time), so any manual line makes the whole
  // order manual.
  //
  // Prefers deliveryTypeSnapshot (frozen at order-creation time) over the live
  // denomination row: an admin editing a SKU's deliveryType after this order
  // was placed must never change which branch an already-in-flight order
  // takes (M-5, backend audit 2026-07-31) — see OrderItem.deliveryTypeSnapshot
  // in schema.prisma for the full rationale. The snapshot is nullable and
  // falls back to the live product.deliveryType for rows that predate this
  // column (this repo's deploy convention is `prisma db push`, which adds the
  // column but never backfills it — see the migration's own comment), which
  // is exactly the pre-existing live-read behavior for those rows.
  const isManual = order.items.some(
    (it) => (it.deliveryTypeSnapshot ?? it.product.deliveryType) !== DeliveryType.AUTO,
  );

  // ── AUTO branch (unchanged behavior) ────────────────────────────────────
  // NOTE: this `if (!isManual) { ... return ... }` early-return is what makes
  // the AUTO and MANUAL branches below mutually exclusive — exactly one of
  // enqueueOwnerOrderPaidEmail / enqueueOwnerManualQueueEmail ever runs per
  // settlePaidOrder call, so a settled order never produces both an
  // OWNER_EMAIL_ORDER_PAID and an OWNER_EMAIL_MANUAL_ORDER_QUEUED email.
  // Don't hoist either call above this branch split.
  if (!isManual) {
    const result = await approveOrder(db, orderId, args);
    // Sourced from the already-fetched `order` (this function's own getOrder
    // call above, which eager-loads items.product/user/voucher — no new
    // query) EXCEPT `paidAt`: approveOrder only stamps that column during its
    // own atomic claim, so the pre-approval `order` still has it null here;
    // `result.order` is the post-approval re-fetch, so its `paidAt` is the
    // real one. `transactionId` prefers whichever of paymentRef/binanceTxid/
    // bybitTxid is set, in that order — these are gateway-specific and never
    // more than one is populated for a given order today, but the preference
    // order keeps this deterministic if that ever changes.
    // Unit prices are indicative. The additive summary uses the same
    // reconciled rows as the admin order page, including every adjustment.
    const toOrderCurrency = orderCurrencyConverter(order);
    const moneyRows = reconciledOrderMoneyRows(order);

    await enqueueOwnerOrderPaidEmail(db, {
      orderId,
      orderCode: order.orderCode,
      total: moneyRows.total,
      currency: order.currency,
      itemCount: order.items.length,
      customerLabel: customerLabel(order.user),
      items: order.items.map((item) => ({
        name: item.product.name,
        variant: item.product.durationLabel,
        quantity: item.quantity,
        unitPrice: toOrderCurrency(item.unitPrice),
      })),
      subtotal: moneyRows.itemsTotal,
      bulkDiscount: moneyRows.bulkDiscount,
      discount: moneyRows.discount,
      walletCredit: moneyRows.walletCredit,
      uniqueCents: moneyRows.uniqueCents,
      paymentMethod: order.paymentMethod,
      transactionId: order.paymentRef ?? order.binanceTxid ?? order.bybitTxid ?? null,
      voucherCode: order.voucher?.code ?? null,
      paidAt: result.order.paidAt ?? new Date(),
      orderUrl: config.ADMIN_PUBLIC_URL ? `${config.ADMIN_PUBLIC_URL.replace(/\/+$/, "")}/orders/${orderId}` : null,
    });
    // The BUYER's own receipt, for a guest shopper — a different recipient,
    // a different template, and no owner toggle, unlike the owner email just
    // above. An AUTO order is genuinely finished at this point, so "your
    // order is ready" is true here; the MANUAL branch below is NOT ready yet
    // and must not send it (fulfillManualOrder does, when it really is).
    await enqueueBuyerOrderReadyEmailIfGuest(db, order);
    // Consistency check, not a state change: approveOrder just wrote DELIVERED
    // to the order AND to every one of its items, so this derives DELIVERED,
    // sees the order already has it, and returns null without touching
    // anything. Kept in the hot path so that stays continuously true rather
    // than true-as-of-the-last-review. `result.order` is deliberately NOT
    // re-fetched afterwards — there is nothing to re-fetch.
    await recomputeOrderStatus(db, orderId);
    return { kind: "delivered", order: result.order, credentials: result.credentials };
  }

  // ── MANUAL branch (no stock; queue for hand-fulfilment) ─────────────────
  const now = new Date();
  await transitionOrderStatus(db, {
    orderId,
    from: OrderStatus.PENDING_VERIFICATION,
    to: OrderStatus.PROCESSING,
    meta: `awaiting manual fulfilment (admin_id=${args.adminId})`,
  });
  // Per-item shadow of the PROCESSING transition above (Trustance Phase 1,
  // Task 3): the order is paid and now sitting in the hand-fulfilment queue, so
  // every line is QUEUED. Same transaction as the order-level write, and — as
  // in the AUTO branch — one value for every item, because this branch decided
  // the outcome for the whole order. Note the branch itself is UNCHANGED: the
  // `isManual` split above still reads order-wide, exactly as before.
  await db.orderItem.updateMany({
    where: { orderId },
    data: { status: OrderItemStatus.QUEUED },
  });
  // Stamp paidAt for the "when did they pay" audit (deliveredAt stays null until
  // the admin fulfils via fulfillManualOrder).
  await db.order.update({ where: { id: orderId }, data: { paidAt: now } });
  // Recognise the order's revenue, using the same `now` just stamped as
  // `paidAt`. This branch is the MANUAL one and never calls `approveOrder`, so
  // it is the only place the posting can happen for a hand-fulfilled order —
  // and the order is genuinely paid here even though it is not delivered yet
  // (`fulfillManualOrder` does that later and must not post again, or the same
  // revenue would be recognised twice; the shared idempotency key
  // `order:{id}:payment` is the backstop for that).
  await postOrderPaymentPosting(db, order, now);
  await enqueueOrderProcessingDm(db, {
    orderId,
    orderCode: order.orderCode,
    telegramId: order.user.telegramId,
    language: order.user.language,
  });
  // Same mutual-exclusivity guarantee noted above the AUTO branch: this call
  // only ever runs on the MANUAL side of the `if (!isManual)` split, so it
  // can never fire alongside enqueueOwnerOrderPaidEmail for the same order.
  const manualItems = order.items.map((item) => ({ name: item.product.name, qty: item.quantity }));
  await enqueueManualOrderAdminAlert(db, {
    orderId,
    orderCode: order.orderCode,
    items: manualItems,
    total: order.totalAmount,
    currency: order.currency,
  });
  await enqueueOwnerManualQueueEmail(db, {
    orderId,
    orderCode: order.orderCode,
    items: manualItems,
    total: order.totalAmount,
    currency: order.currency,
  });
  logger.info(
    `Order ${order.orderCode} payment confirmed; queued for manual fulfilment (admin ${args.adminId}).`,
  );
  // Same consistency check as the AUTO branch. Every item is QUEUED, which is
  // an in-flight state, so the derivation declines and the order keeps the
  // PROCESSING it was just given.
  await recomputeOrderStatus(db, orderId);
  const refreshed = await getOrder(db, orderId);
  return { kind: "processing", order: refreshed!, credentials: [] };
}

/**
 * Manual fulfilment: an admin delivers a queued PROCESSING order by hand. Saves
 * the typed content, flips PROCESSING → DELIVERED atomically (same claim pattern
 * and OrderStatusHistory-write bypass as approveOrder), runs the shared referral
 * + testimonial side effects, and enqueues the buyer's content DM (read live at
 * dispatch). No stock is touched — manual SKUs never reserved any.
 */
export async function fulfillManualOrder(
  db: Db,
  orderId: number,
  args: { adminId: number; content: string },
): Promise<{ order: OrderWithIncludes }> {
  const content = args.content.trim();
  if (!content) throw new ValidationError("error.manual_content_required");

  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");

  const now = new Date();
  // Atomic claim PROCESSING → DELIVERED, writing the content + deliveredAt in the
  // same UPDATE so a double-tap can't fulfil twice (count!==1 on a lost race).
  const claim = await db.order.updateMany({
    where: { id: orderId, status: OrderStatus.PROCESSING },
    data: { status: OrderStatus.DELIVERED, deliveredContent: encryptDeliveredContent(content, orderId), deliveredAt: now },
  });
  if (claim.count !== 1) throw new ValidationError("error.order_not_processing");
  await db.orderStatusHistory.create({
    data: { orderId, status: OrderStatus.DELIVERED, meta: `manual_fulfill by admin_id=${args.adminId}` },
  });
  // Per-item shadow of the claim above (Trustance Phase 1, Task 3): the admin
  // hand-delivered the order, so every line moves QUEUED -> DELIVERED. Behind
  // the atomic claim, so a lost double-tap race (claim.count !== 1 throws
  // above) never reaches it.
  await db.orderItem.updateMany({
    where: { orderId },
    data: { status: OrderItemStatus.DELIVERED },
  });

  await finalizeDeliverySideEffects(db, order, now);

  await enqueueManualDeliveredDm(db, {
    orderId,
    orderCode: order.orderCode,
    telegramId: order.user.telegramId,
    language: order.user.language,
  });

  // The second of this event's two call sites, and the reason there are two:
  // a guest who bought a manual SKU never went through settlePaidOrder's AUTO
  // branch, so this is the only point their order becomes ready. Placed after
  // the atomic PROCESSING -> DELIVERED claim above, so a lost double-tap race
  // (claim.count !== 1 throws) can never produce a second email. Note it takes
  // the pre-claim `order`, which carries no delivered content — `args.content`
  // is the credential the admin just typed and must never reach the payload.
  await enqueueBuyerOrderReadyEmailIfGuest(db, order);

  await logAdminAction(db, {
    adminId: args.adminId,
    action: "order.manual_fulfill",
    targetType: "order",
    targetId: order.id,
    details: `Manually fulfilled order ${order.orderCode} and sent the account to the buyer.`,
  });

  logger.info(`Manually fulfilled order ${order.orderCode} by admin ${args.adminId}`);
  // Same consistency check as settlePaidOrder's two branches: the claim above
  // wrote DELIVERED to the order and to every item, so this derives DELIVERED,
  // finds it already set, and changes nothing.
  await recomputeOrderStatus(db, orderId);
  const refreshed = await getOrder(db, orderId);
  return { order: refreshed! };
}

/**
 * Update a manual_with_info order's buyer answers while it is still PROCESSING
 * (before the admin fulfils it). Re-validates the answers against the SKU's
 * field spec, once per unit, and persists the normalized JSON. Locked once the
 * order leaves PROCESSING (throws error.order_not_processing).
 */
export async function updateOrderCustomerData(
  db: Db,
  orderId: number,
  answers: unknown,
): Promise<OrderWithIncludes> {
  // Raw reads: editing the buyer's answers needs no secret (see getOrderRaw).
  const order = await getOrderRaw(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.status !== OrderStatus.PROCESSING) {
    throw new ValidationError("error.order_not_processing");
  }
  const denom = order.items[0]?.product as { additionalFields?: string | null } | undefined;
  const fields = parseAdditionalFields(denom?.additionalFields ?? null);
  // One answer-map per unit (item), matching how they were collected at checkout.
  const normalized = validateCustomerData(fields, answers, order.items.length);
  await db.order.update({
    where: { id: orderId },
    data: { customerData: JSON.stringify(normalized) },
  });
  const refreshed = await getOrderRaw(db, orderId);
  return refreshed!;
}

/** The eligibility flags the Orders list/detail/bulk-action surfaces all
 * gate their actions on — one function so those three can't drift apart
 * (see `docs/` refactor notes on the Orders admin page). `telegramId` is
 * `null` for web-only buyers, who have no Telegram DM to resend to. */
export interface OrderEligibility {
  isDelivered: boolean;
  /** PENDING_VERIFICATION — one-click approve/deliver. */
  canAct: boolean;
  /** PENDING_VERIFICATION | UNDERPAID | PROCESSING — eligible for
   * credit-to-balance. PROCESSING is a paid manual-fulfilment order an admin
   * couldn't source the account for — H-2 (backend audit, 2026-07-31): this
   * used to be missing even though `canReject` already covered PROCESSING,
   * so Reject was the only refund-shaped action offered, and rejecting moves
   * the order to the terminal REJECTED state where `creditOrderToBalance`
   * then refuses to act — stranding the buyer's already-paid money. */
  canCredit: boolean;
  /** PROCESSING — manual hand-fulfil, needs admin-typed content. */
  canFulfill: boolean;
  /** PENDING_VERIFICATION | PROCESSING — reject is legal from both. */
  canReject: boolean;
  /** Delivered orders with a Telegram buyer can have their credentials DM resent. */
  canResend: boolean;
  /** CANCELLED, actually paid (a `delivery_failed`/`unmatched` gateway ledger row is linked to it —
   * `orderHasIncomingLedgerPayment`), and with no proof that payment was ever
   * handed back (`cancelledOrderIdsWithMoneyReturned`) — credit it to the
   * buyer's balance (`creditOrderToBalance`'s already-cancelled path, which
   * enforces the same two checks). Both halves matter: "nothing went back" is
   * also true of an abandoned order that was never paid, and offering the
   * credit there would mint money. Unlike every other flag this is NOT
   * derivable from `status` alone, so it fails closed: false unless the caller
   * explicitly resolved both and passed `cancelledOrderHasMoneyReturned: false`
   * AND `cancelledOrderWasPaid: true`. List/bulk callers that don't look them
   * up per row therefore never offer it. */
  canCreditCancelled: boolean;
}

export function computeOrderEligibility(
  status: string,
  telegramId: bigint | null,
  opts?: { cancelledOrderHasMoneyReturned?: boolean; cancelledOrderWasPaid?: boolean },
): OrderEligibility {
  const isDelivered = status === OrderStatus.DELIVERED;
  return {
    isDelivered,
    canAct: status === OrderStatus.PENDING_VERIFICATION,
    canCredit:
      status === OrderStatus.PENDING_VERIFICATION ||
      status === OrderStatus.UNDERPAID ||
      status === OrderStatus.PROCESSING,
    canFulfill: status === OrderStatus.PROCESSING,
    canReject: status === OrderStatus.PENDING_VERIFICATION || status === OrderStatus.PROCESSING,
    canResend: isDelivered && telegramId != null,
    canCreditCancelled:
      status === OrderStatus.CANCELLED &&
      opts?.cancelledOrderHasMoneyReturned === false &&
      opts?.cancelledOrderWasPaid === true,
  };
}

// ---- Filtered list/count for the admin web ----

export interface OrderFilter {
  status?: OrderStatus | OrderStatus[] | null;
  userId?: number | null;
  since?: Date | null;
  until?: Date | null;
  orderCode?: string | null;
  /** Free-text search across order code + customer identity fields +
   * purchased product name — the Orders page's search box. Replaces
   * orderCode-only matching for the list/export routes; `orderCode` itself
   * stays available for any caller that wants an exact/prefix code match. */
  q?: string | null;
  paymentMethod?: string | null;
  voucherId?: number | null;
  /** Restrict to this exact set of order ids — the bulk-toolbar's
   * "export only the selected rows" path. */
  ids?: number[] | null;
  /**
   * Restrict to one `OrderKind` ("PRODUCT" / "WALLET_TOPUP"). Added by
   * Financial Ledger M6 (Task 6a) so a sales-oriented caller can exclude
   * wallet top-ups from a filtered list/count — before this, no caller could
   * even ask.
   *
   * Omitting it counts/lists BOTH kinds, and `orderWhere` deliberately applies
   * no default: this is the generic helper behind the admin Orders list, whose
   * existing callers (the `/api/orders` list + its `total`, `/api/orders/kpis`'
   * "Total Orders" card and "All" tab badge, `/api/orders/export`) must keep
   * showing every kind — an admin resolves top-up orders on that page too, and
   * a count that disagreed with its own list would be a bug, not a fix. A new
   * sales/revenue caller must pass `OrderKind.PRODUCT` explicitly.
   */
  kind?: OrderKind | null;
}

function orderWhere(f: OrderFilter): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (f.status != null) {
    where.status = Array.isArray(f.status) ? { in: f.status } : f.status;
  }
  if (f.userId != null) where.userId = f.userId;
  // Top-level (AND) clause, so it narrows the `q` free-text OR below rather
  // than competing with it. No default — see OrderFilter.kind.
  if (f.kind) where.kind = f.kind;
  if (f.orderCode) where.orderCode = { contains: f.orderCode.trim(), mode: "insensitive" };
  if (f.paymentMethod) where.paymentMethod = f.paymentMethod;
  if (f.voucherId != null) where.voucherId = f.voucherId;
  if (f.ids != null) where.id = { in: f.ids };
  if (f.since != null || f.until != null) {
    where.createdAt = {};
    if (f.since != null) where.createdAt.gte = f.since;
    if (f.until != null) where.createdAt.lte = f.until;
  }
  if (f.q) {
    const term = f.q.trim();
    const cleanTerm = term.replace(/^#/, "").trim();
    const or: Prisma.OrderWhereInput[] = [
      { orderCode: { contains: term, mode: "insensitive" } },
      { user: { username: { contains: term, mode: "insensitive" } } },
      { user: { fullName: { contains: term, mode: "insensitive" } } },
      { user: { loginUsername: { contains: term, mode: "insensitive" } } },
      { user: { email: { contains: term, mode: "insensitive" } } },
      // Guest buyers have no username/fullName/loginUsername/email — only
      // guestEmail — and Task 7 now shows that address in the Customer
      // column, so pasting it back into this search box has to find the
      // order. Same `contains` shape as the other identity fields above,
      // explicit `mode: "insensitive"` (Postgres's `contains` is case-sensitive
      // unless it is spelled out).
      { user: { guestEmail: { contains: term, mode: "insensitive" } } },
      { items: { some: { product: { name: { contains: term, mode: "insensitive" } } } } },
    ];
    if (cleanTerm !== term) {
      or.push({ orderCode: { contains: cleanTerm, mode: "insensitive" } });
    }
    if (/^\d+$/.test(cleanTerm)) {
      const num = Number(cleanTerm);
      if (Number.isSafeInteger(num) && num > 0) {
        or.push({ id: num });
      }
      or.push({ user: { telegramId: BigInt(cleanTerm) } });
    }
    where.OR = or;
  }
  return where;
}

export async function listOrders(
  db: Db,
  opts: OrderFilter & { limit?: number; offset?: number } = {},
) {
  const orders = await db.order.findMany({
    where: orderWhere(opts),
    include: { user: { select: ORDER_USER_SELECT }, items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
  });
  return orders.map(withoutDeliveredContent);
}

export function countOrders(db: Db, opts: OrderFilter = {}) {
  return db.order.count({ where: orderWhere(opts) });
}

// ---- Sold-count aggregates (§4.1) — Product Detail "X Terjual" + Produk Populer ----

/**
 * Sparse map: denominationId → units delivered (DELIVERED orders only), for
 * denominations with ≥1 sale. `OrderItem.productId` holds the Denomination
 * id (same convention as `StockItem.productId`) — see `lowStockDenominations`
 * in `catalog.ts` for the analogous in-memory grouping pattern.
 *
 * Prisma 5.22 accepts a relation filter (`order: { status }`) inside
 * `groupBy`'s `where`, so the single-query groupBy below is used directly
 * (verified by this file's test suite exercising it against a real DB).
 */
export async function soldCountsByDenomination(
  db: Db,
  denominationIds: number[],
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!denominationIds.length) return map;

  const rows = await db.orderItem.groupBy({
    by: ["productId"],
    where: { productId: { in: denominationIds }, order: { status: OrderStatus.DELIVERED } },
    _sum: { quantity: true },
  });
  for (const r of rows) {
    const sum = r._sum.quantity ?? 0;
    if (sum > 0) map.set(r.productId, sum);
  }
  return map;
}

/** Units delivered for one denomination (DELIVERED orders only). */
export async function soldCountForDenomination(db: Db, denominationId: number): Promise<number> {
  const map = await soldCountsByDenomination(db, [denominationId]);
  return map.get(denominationId) ?? 0;
}

/**
 * Units delivered for a whole mid-tier Product (DELIVERED orders only) — the
 * sum across its denominations. Feeds the Product picker's "X sold" line.
 * `OrderItem.productId` is a Denomination id, so we resolve the product's
 * denomination ids first, then reuse {@link soldCountsByDenomination}.
 */
export async function soldCountForProduct(db: Db, productId: number): Promise<number> {
  const denoms = await db.denomination.findMany({ where: { productId }, select: { id: true } });
  const ids = denoms.map((d) => d.id);
  if (!ids.length) return 0;
  const map = await soldCountsByDenomination(db, ids);
  let total = 0;
  for (const id of ids) total += map.get(id) ?? 0;
  return total;
}
