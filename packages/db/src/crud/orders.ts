/**
 * Orders domain — the heart of the money/stock logic. Port of the "Orders"
 * section of Python crud.py. Multi-step mutators (create/approve/reject/cancel)
 * MUST run inside a prisma.$transaction so the order, stock, wallet, voucher
 * and outbox changes land atomically.
 */
import { config } from "@app/core/config";
import { OrderStatus, StockStatus, UserRole, DeliveryType, langCode } from "@app/core/enums";
import { parseAdditionalFields, validateCustomerData } from "@app/core/deliveryFields";
import {
  quantizeMoney,
  generateOrderCode,
  computeUniqueCents,
} from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { effectiveUnitPrice, type FlashFields } from "@app/core/flash";
import { bulkDiscountFor } from "@app/core/bulk";
import { utcStamp, addMinutes } from "@app/core/datetime";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { NotificationEvent } from "@app/core/enums";
import { publicChannelId } from "@app/core/runtime";
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getBulkPricingForDenomination } from "./catalog";
import {
  getVoucherByCode,
  applyVoucherToSubtotal,
  assertVoucherNotRedeemedByUser,
  computeEligibleAmounts,
  type EligibilityLine,
} from "./vouchers";
import { countAvailableStock, allocateOneAvailableStock } from "./stock";
import { adjustWallet, getUser } from "./users";
import { clearCart, getCart } from "./cart";
import { getSetting } from "./settings";
import { maybePayReferralCommission } from "./referrals";
import {
  enqueueNotification,
  enqueueOrderProcessingDm,
  enqueueManualDeliveredDm,
  enqueueManualOrderAdminAlert,
  enqueueOwnerOrderPaidEmail,
  enqueueOwnerManualQueueEmail,
} from "./notifications";
import { logAdminAction } from "./audit";
import { transitionOrderStatus } from "./orderStatus";

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
// inside one $transaction with Prisma's default 5s timeout, holding SQLite's
// single writer long enough to starve every other writer (the bot, webhooks,
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
 * increment (which only stayed safe so far because SQLite's BEGIN IMMEDIATE
 * serializes concurrent transactions). Pricing-2 fix, security audit
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
  };
};

type BulkRule = { minQuantity: number; discountPercent: Decimal.Value };

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

async function uniqueOrderCode(db: Db): Promise<string> {
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

export function getOrder(db: Db, orderId: number) {
  return db.order.findUnique({ where: { id: orderId }, include: fullInclude });
}

export function getOrderByCode(db: Db, orderCode: string) {
  return db.order.findUnique({
    where: { orderCode },
    include: { items: { include: { product: true } }, user: { select: ORDER_USER_SELECT } },
  });
}

/** By code with the full include (items+stockItem+product, user, voucher) —
 * storefront order detail needs stockItem.credentials for DELIVERED orders. */
export function getOrderByCodeFull(db: Db, orderCode: string) {
  return db.order.findUnique({ where: { orderCode }, include: fullInclude });
}

/** The eager-loaded Order shape returned by getOrder/getOrderByCodeFull. */
type OrderWithIncludes = NonNullable<Awaited<ReturnType<typeof getOrder>>>;

export async function createOrderFromCart(
  db: Db,
  args: {
    user: { id: number; role: string; walletBalance: Decimal.Value };
    voucherCode?: string | null;
    walletAmount?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Persisted verbatim onto Order.customerData; null otherwise. */
    customerData?: string | null;
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
  const rawCart = (await getCart(db, args.user.id)) as unknown as CartLine[];
  const cart = rawCart.filter((ci) => ci.product.isActive);
  if (cart.length === 0) throw new ValidationError("error.cart_empty");
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

  // 4. Wallet debit
  const walletAmount = q4(Decimal.max(ZERO, new Decimal(args.walletAmount ?? 0)));
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
  const infoLine = cart.find((ci) => ci.product.deliveryType === DeliveryType.MANUAL_WITH_INFO);
  if (infoLine) {
    const fields = parseAdditionalFields(infoLine.product.additionalFields);
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
  const order = await db.order.create({
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
      expiresAt: addMinutes(new Date(), config.PAYMENT_WINDOW_MINUTES),
    },
  });

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
  // Stock reservation is still one allocateOneAvailableStock call per unit
  // (it's individually optimistic-locked — see its doc comment — so each
  // unit's assignment genuinely depends on a fresh read of what's still
  // AVAILABLE after every earlier unit in this same order reserved its row;
  // that can't be batched without changing which stock item lands on which
  // line). What CAN be batched is persisting the resulting OrderItem rows:
  // collect one createMany input per unit here, across every line, and issue
  // a single createMany after the loop instead of one create per unit — same
  // rows, same stock assignments, same order, just one insert query instead
  // of O(units) (M-7 fix, backend audit 2026-07-31).
  const orderItemsData: Prisma.OrderItemCreateManyInput[] = [];
  for (const ci of cart) {
    const unit = q4(unitPrice(ci.product, isReseller, pricedAt));
    const isManual = ci.product.deliveryType !== DeliveryType.AUTO;
    const warrantyDays = (ci.product as unknown as { warrantyDays: number }).warrantyDays;
    for (let k = 0; k < ci.quantity; k++) {
      let stockItemId: number | null = null;
      if (!isManual) {
        const reserved = await allocateOneAvailableStock(db, ci.productId, order.id);
        if (!reserved) {
          throw new ValidationError("error.out_of_stock", { product: ci.product.name });
        }
        stockItemId = reserved.id;
      }
      orderItemsData.push({
        orderId: order.id,
        productId: ci.productId,
        stockItemId,
        quantity: 1,
        unitPrice: unit,
        warrantyDaysSnapshot: warrantyDays,
        deliveryTypeSnapshot: ci.product.deliveryType,
      });
    }
  }
  if (orderItemsData.length > 0) {
    await db.orderItem.createMany({ data: orderItemsData });
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
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    /** IDR credit balance to spend on this order (clamped to order total). */
    walletAmount?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Persisted verbatim onto Order.customerData; null otherwise. */
    customerData?: string | null;
  },
) {
  // args.productId is a denomination id (the sellable SKU).
  const product = await db.denomination.findUnique({ where: { id: args.productId } });
  if (!product) throw new ValidationError("error.out_of_stock", { product: "(unknown)" });
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
  if (product.deliveryType === DeliveryType.MANUAL_WITH_INFO) {
    const fields = parseAdditionalFields(product.additionalFields);
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

  const order = await db.order.create({
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
      expiresAt: addMinutes(new Date(), config.PAYMENT_WINDOW_MINUTES),
    },
  });

  // Reserve stock atomically per unit for AUTO (Checkout-2/Stock-1 fix — see
  // createOrderFromCart's matching loop for the full rationale); MANUAL creates
  // stockless OrderItems.
  for (let k = 0; k < args.quantity; k++) {
    let stockItemId: number | null = null;
    if (!isManual) {
      const reserved = await allocateOneAvailableStock(db, args.productId, order.id);
      if (!reserved) {
        throw new ValidationError("error.out_of_stock", { product: product.name });
      }
      stockItemId = reserved.id;
    }
    await db.orderItem.create({
      data: {
        orderId: order.id,
        productId: args.productId,
        stockItemId,
        quantity: 1,
        unitPrice: q4(unit),
        warrantyDaysSnapshot: product.warrantyDays,
        deliveryTypeSnapshot: product.deliveryType,
      },
    });
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
  const walletAmountReq = q4(Decimal.max(ZERO, new Decimal(args.walletAmount ?? 0)));
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

export function listUserOrders(db: Db, userId: number, limit = 5, offset = 0) {
  return db.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: offset,
    take: limit,
    include: { items: { include: { product: true } } },
  });
}

export function countUserOrders(db: Db, userId: number) {
  return db.order.count({ where: { userId } });
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
    db.order.count({ where: { status: OrderStatus.DELIVERED } }),
    db.order.groupBy({ by: ["userId"], where: { status: OrderStatus.DELIVERED } }),
  ]);
  return { deliveredOrders, customers: buyers.length };
}

export function countUserPendingOrders(db: Db, userId: number) {
  return db.order.count({
    where: { userId, status: OrderStatus.PENDING_PAYMENT },
  });
}

export function listUserDeliveredOrders(db: Db, userId: number, limit = 50) {
  return db.order.findMany({
    where: { userId, status: OrderStatus.DELIVERED },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { items: { include: { product: true, stockItem: true } } },
  });
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

/** Orders awaiting payment confirmation right now — covers every payment
 * method's pre-confirmation states, including the Bybit BSC on-chain
 * milestones ("Pending Payments" on the dashboard). */
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
 */
export function countAwaitingManualFulfillment(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.PROCESSING } });
}

/** Orders successfully delivered — the Orders page KPI's "Delivered" count. */
export function countDelivered(db: Db): Promise<number> {
  return db.order.count({ where: { status: OrderStatus.DELIVERED } });
}

/** Orders voided (admin-cancelled or rejected) — folded together for the
 * Orders page KPI's "Cancelled" count, matching the display bucket
 * OrderStatusBadge groups them into on the client. */
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

/** Release any reserved stock + refund wallet + roll back voucher usage. */
async function releaseOrderHolds(
  db: Db,
  order: NonNullable<Awaited<ReturnType<typeof getOrder>>>,
) {
  for (const item of order.items) {
    if (item.stockItem && item.stockItem.status === StockStatus.RESERVED) {
      await db.stockItem.update({
        where: { id: item.stockItem.id },
        data: { status: StockStatus.AVAILABLE, orderId: null, reservedAt: null },
      });
    }
  }
  if (new Decimal(order.walletUsed).greaterThan(0)) {
    // Credit back to the balance matching the order's currency: an order spends
    // and is refunded against the same credit balance (IDR or USDT).
    await adjustWallet(db, order.userId, order.walletUsed, {
      currency: order.currency === "USDT" ? "USDT" : "IDR",
      allowNegative: true,
      reason: "order_refund",
      orderId: order.id,
    });
  }
  if (order.voucherId) {
    const v = await db.voucher.findUnique({ where: { id: order.voucherId } });
    if (v && v.usedCount > 0) {
      await db.voucher.update({
        where: { id: v.id },
        data: { usedCount: { decrement: 1 } },
      });
    }
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
 * at a terminal state (REJECTED/CANCELLED) that `creditOrderToBalance`
 * refuses to touch afterward ("error.order_terminal") — so once an order's
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

export async function cancelOrder(db: Db, orderId: number, reason: string) {
  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (
    order.status === OrderStatus.CANCELLED ||
    order.status === OrderStatus.REJECTED ||
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

  await releaseOrderHolds(db, order);
  await db.order.update({
    where: { id: orderId },
    data: {
      adminNote: `${order.adminNote ?? ""}\n[cancel] ${reason}`,
    },
  });
  await transitionOrderStatus(db, { orderId, from: order.status, to: OrderStatus.CANCELLED, meta: reason });
  logger.info(`Cancelled order ${order.orderCode} — reason: ${reason}`);
  return getOrder(db, orderId);
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
 * Idempotent: a terminal order, or a pre-existing `unfulfilled_credit` ledger
 * row for this order, makes the call a no-op — a retry/double-tap can't
 * double-credit. When `binanceTxId` is given, that ledger row is re-tagged
 * `credited_to_balance` and linked to the order (mirrors `manualMatchTx`).
 *
 * Audited at the route layer via `logAdminAction`.
 */
export async function creditOrderToBalance(
  db: Db,
  args: { orderId: number; amount?: Decimal.Value; adminId: number; binanceTxId?: string | null },
): Promise<{ credited: Decimal; currency: "IDR" | "USDT" }> {
  const order = await getOrder(db, args.orderId);
  if (!order) throw new ValidationError("error.order_not_found");

  const terminal: string[] = [
    OrderStatus.CANCELLED,
    OrderStatus.REJECTED,
    OrderStatus.REFUNDED,
    OrderStatus.DELIVERED,
  ];
  if (terminal.includes(order.status)) {
    throw new ValidationError("error.order_terminal");
  }

  // Double-credit guard: bail if this order already has an unfulfilled_credit row.
  const prior = await db.walletTransaction.findFirst({
    where: { orderId: order.id, reason: "unfulfilled_credit" },
  });
  if (prior) throw new ValidationError("error.already_credited");

  const currency: "IDR" | "USDT" = order.currency === "USDT" ? "USDT" : "IDR";
  const amount = q4(Decimal.max(ZERO, new Decimal(args.amount ?? order.totalAmount)));

  if (amount.greaterThan(0)) {
    await adjustWallet(db, order.userId, amount, {
      currency,
      reason: "unfulfilled_credit",
      orderId: order.id,
      adminId: args.adminId,
    });
  }

  // Release held stock + return the already-spent walletUsed (in order currency)
  // + roll back voucher usage. Distinct money from the paid amount credited above.
  await releaseOrderHolds(db, order);

  await db.order.update({
    where: { id: order.id },
    data: {
      adminNote: `${order.adminNote ?? ""}\n[credit_to_balance] ${amount.toString()} ${currency} by admin_id=${args.adminId}`,
    },
  });
  await transitionOrderStatus(db, {
    orderId: order.id,
    from: order.status,
    to: OrderStatus.CANCELLED,
    meta: `credit_to_balance by admin_id=${args.adminId}`,
  });

  if (args.binanceTxId) {
    await db.processedBinanceTx
      .update({
        where: { binanceTxId: args.binanceTxId },
        data: { orderId: order.id, outcome: "credited_to_balance" },
      })
      .catch(() => undefined);
  }

  logger.info(
    `Credited order ${order.orderCode} (${amount.toString()} ${currency}) to buyer's credit balance — approved by admin ${args.adminId}`,
  );
  return { credited: amount, currency };
}

export async function rejectOrder(
  db: Db,
  orderId: number,
  args: { adminId: number; reason: string },
) {
  const order = await getOrder(db, orderId);
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

  await releaseOrderHolds(db, order);
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
  return getOrder(db, orderId);
}

/**
 * Admin approves a pending order: allocate/flip stock → SOLD, mark DELIVERED,
 * pay referral commission, enqueue the testimoni outbox row (same tx), and
 * return the credentials to DM the buyer.
 */
export async function approveOrder(
  db: Db,
  orderId: number,
  args: { adminId: number },
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }> {
  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");

  // Atomic conditional claim: only ONE caller can flip PENDING_VERIFICATION ->
  // DELIVERED for this order, regardless of DB isolation level — a single
  // UPDATE's row-level atomicity holds even under Read Committed, unlike the
  // read-then-throw check this replaces (which only stayed safe so far
  // because SQLite's BEGIN IMMEDIATE happens to serialize concurrent
  // transactions). Making the guard explicit removes that implicit
  // dependency ahead of a possible Postgres migration (Bot-2 fix, security
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

  const credentials: string[] = [];

  for (const item of order.items) {
    let stock = item.stockItem;
    if (!stock || stock.status !== StockStatus.RESERVED) {
      const replacement = await allocateOneAvailableStock(db, item.productId, order.id);
      if (!replacement) {
        throw new ValidationError("error.cannot_deliver_out_of_stock", {
          product: item.product.name,
        });
      }
      await db.orderItem.update({
        where: { id: item.id },
        data: { stockItemId: replacement.id },
      });
      stock = replacement;
    }
    await db.stockItem.update({
      where: { id: stock.id },
      data: { status: StockStatus.SOLD, soldAt: now },
    });
    credentials.push(stock.credentials);
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
 * Post-delivery side effects shared by the AUTO path (approveOrder) and the
 * MANUAL path (fulfillManualOrder): pay the referee's referral commission and
 * enqueue the public-channel testimonial. Runs AFTER the atomic DELIVERED claim
 * in both callers, so a lost race can't reach it twice (referral is itself
 * gated on "referee's first delivered order").
 */
async function finalizeDeliverySideEffects(
  db: Db,
  order: OrderWithIncludes,
  now: Date,
): Promise<void> {
  // Referral commission (referee's first delivered order only). Currency +
  // fxRate ride along so IDR orders convert to the USDT wallet basis.
  await maybePayReferralCommission(db, {
    id: order.id,
    userId: order.userId,
    orderCode: order.orderCode,
    totalAmount: order.totalAmount,
    currency: order.currency,
    fxRate: order.fxRate,
  });

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
      total: String(order.totalAmount),
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
    await enqueueOwnerOrderPaidEmail(db, {
      orderId,
      orderCode: order.orderCode,
      total: order.totalAmount,
      currency: order.currency,
      itemCount: order.items.length,
    });
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
  // Stamp paidAt for the "when did they pay" audit (deliveredAt stays null until
  // the admin fulfils via fulfillManualOrder).
  await db.order.update({ where: { id: orderId }, data: { paidAt: now } });
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
    data: { status: OrderStatus.DELIVERED, deliveredContent: content, deliveredAt: now },
  });
  if (claim.count !== 1) throw new ValidationError("error.order_not_processing");
  await db.orderStatusHistory.create({
    data: { orderId, status: OrderStatus.DELIVERED, meta: `manual_fulfill by admin_id=${args.adminId}` },
  });

  await finalizeDeliverySideEffects(db, order, now);

  await enqueueManualDeliveredDm(db, {
    orderId,
    orderCode: order.orderCode,
    telegramId: order.user.telegramId,
    language: order.user.language,
  });

  await logAdminAction(db, {
    adminId: args.adminId,
    action: "order.manual_fulfill",
    targetType: "order",
    targetId: order.id,
    details: `Manually fulfilled order ${order.orderCode} and sent the account to the buyer.`,
  });

  logger.info(`Manually fulfilled order ${order.orderCode} by admin ${args.adminId}`);
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
  const order = await getOrder(db, orderId);
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
  const refreshed = await getOrder(db, orderId);
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
}

export function computeOrderEligibility(status: string, telegramId: bigint | null): OrderEligibility {
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
}

function orderWhere(f: OrderFilter): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (f.status != null) {
    where.status = Array.isArray(f.status) ? { in: f.status } : f.status;
  }
  if (f.userId != null) where.userId = f.userId;
  if (f.orderCode) where.orderCode = { contains: f.orderCode.trim() };
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
      { orderCode: { contains: term } },
      { user: { username: { contains: term } } },
      { user: { fullName: { contains: term } } },
      { user: { loginUsername: { contains: term } } },
      { user: { email: { contains: term } } },
      // Guest buyers have no username/fullName/loginUsername/email — only
      // guestEmail — and Task 7 now shows that address in the Customer
      // column, so pasting it back into this search box has to find the
      // order. Same `contains` shape as the other identity fields above, so
      // it inherits the same (SQLite-default) case-insensitivity.
      { user: { guestEmail: { contains: term } } },
      { items: { some: { product: { name: { contains: term } } } } },
    ];
    if (cleanTerm !== term) {
      or.push({ orderCode: { contains: cleanTerm } });
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

export function listOrders(
  db: Db,
  opts: OrderFilter & { limit?: number; offset?: number } = {},
) {
  return db.order.findMany({
    where: orderWhere(opts),
    include: { user: { select: ORDER_USER_SELECT }, items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
  });
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
 * Prisma 5.22 + SQLite accepts a relation filter (`order: { status }`) inside
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
