/**
 * Orders domain — the heart of the money/stock logic. Port of the "Orders"
 * section of Python crud.py. Multi-step mutators (create/approve/reject/cancel)
 * MUST run inside a prisma.$transaction so the order, stock, wallet, voucher
 * and outbox changes land atomically.
 */
import { config } from "@app/core/config";
import { OrderStatus, StockStatus, UserRole, langCode } from "@app/core/enums";
import {
  quantizeMoney,
  generateOrderCode,
  computeUniqueCents,
} from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { utcStamp, addMinutes } from "@app/core/datetime";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { NotificationEvent } from "@app/core/enums";
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { getBulkPricingForDenomination } from "./catalog";
import { getVoucherByCode, applyVoucherToSubtotal, assertVoucherNotRedeemedByUser } from "./vouchers";
import { countAvailableStock, allocateOneAvailableStock } from "./stock";
import { adjustWallet, getUser } from "./users";
import { clearCart, getCart } from "./cart";
import { maybePayReferralCommission } from "./referrals";
import { enqueueNotification } from "./notifications";
import { logAdminAction } from "./audit";

const ZERO = new Decimal(0);
const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);
// Matches the cart's own cap (packages/db/src/crud/cart.ts) — the final
// server-side boundary regardless of how quantity reached this function
// (typed input, a crafted callback, or a cart row). Checkout-5 fix, security
// audit 2026-06-23.
const MAX_QTY_PER_ORDER = 99;

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

/** Eager-load shape matching the Python get_order selectinload set. */
const fullInclude = {
  items: { include: { product: true, stockItem: true } },
  user: true,
  voucher: true,
} satisfies Prisma.OrderInclude;

type CartLine = {
  productId: number;
  quantity: number;
  product: { price: Decimal.Value; resellerPrice: Decimal.Value | null; name: string };
};

type BulkRule = { minQuantity: number; discountPercent: Decimal.Value };

function unitPrice(
  product: { price: Decimal.Value; resellerPrice: Decimal.Value | null },
  isReseller: boolean,
): Decimal {
  return new Decimal(
    isReseller && product.resellerPrice != null ? product.resellerPrice : product.price,
  );
}

/** Pure: total bulk discount across all cart lines. */
export function computeBulkDiscountForCart(
  cart: CartLine[],
  bulkRules: Record<number, BulkRule>,
  isReseller = false,
): Decimal {
  let total = ZERO;
  for (const ci of cart) {
    const rule = bulkRules[ci.productId];
    if (!rule || ci.quantity < rule.minQuantity) continue;
    const itemSubtotal = unitPrice(ci.product, isReseller).times(ci.quantity);
    total = total.plus(itemSubtotal.times(rule.discountPercent).div(100));
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
    include: { items: { include: { product: true } }, user: true },
  });
}

/** By code with the full include (items+stockItem+product, user, voucher) —
 * storefront order detail needs stockItem.credentials for DELIVERED orders. */
export function getOrderByCodeFull(db: Db, orderCode: string) {
  return db.order.findUnique({ where: { orderCode }, include: fullInclude });
}

export async function createOrderFromCart(
  db: Db,
  args: { user: { id: number; role: string; walletBalance: Decimal.Value }; voucherCode?: string | null; walletAmount?: Decimal.Value },
) {
  const cart = (await getCart(db, args.user.id)) as unknown as CartLine[];
  if (cart.length === 0) throw new ValidationError("error.cart_empty");
  // Cart rows are normally clamped to 1-99 by cart.ts, but the very first
  // insert path (addToCart's create branch) doesn't clamp — re-validate here
  // as the final server-side boundary (Checkout-5 fix, security audit
  // 2026-06-23).
  for (const ci of cart) assertValidQuantity(ci.quantity, ci.product.name);

  const isReseller = args.user.role === UserRole.RESELLER;

  // 1. Subtotal
  let subtotal = ZERO;
  for (const ci of cart) {
    subtotal = subtotal.plus(unitPrice(ci.product, isReseller).times(ci.quantity));
  }

  // 2. Bulk discount
  const bulkRules: Record<number, BulkRule> = {};
  for (const ci of cart) {
    const rule = await getBulkPricingForDenomination(db, ci.productId);
    if (rule) bulkRules[ci.productId] = rule;
  }
  const bulkDiscount = computeBulkDiscountForCart(cart, bulkRules, isReseller);

  // 3. Voucher
  let discount = ZERO;
  let voucher = null as Awaited<ReturnType<typeof getVoucherByCode>> | null;
  if (args.voucherCode) {
    voucher = await getVoucherByCode(db, args.voucherCode);
    if (!voucher) throw new ValidationError("error.voucher_not_found");
    await assertVoucherNotRedeemedByUser(db, voucher.id, args.user.id);
    discount = applyVoucherToSubtotal(voucher, subtotal);
  }

  const afterDiscount = subtotal.minus(bulkDiscount).minus(discount);

  // 4. Wallet debit
  const walletAmount = q4(Decimal.max(ZERO, new Decimal(args.walletAmount ?? 0)));
  const walletUsed = Decimal.min(walletAmount, afterDiscount);
  if (walletUsed.greaterThan(args.user.walletBalance)) {
    throw new ValidationError("error.insufficient_wallet");
  }

  // 5. Order code
  const orderCode = await uniqueOrderCode(db);

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
      expiresAt: addMinutes(new Date(), config.PAYMENT_WINDOW_MINUTES),
    },
  });

  // 7. Pre-check every line's availability before reserving anything, so the
  // common "you asked for more than we have" case fails before any row is
  // touched (rather than leaving earlier lines reserved). Then reserve stock
  // atomically (one row per unit, AVAILABLE -> RESERVED) and create one
  // OrderItem per unit. allocateOneAvailableStock is itself optimistic-locked,
  // so concurrent checkouts for the same product can never both reserve the
  // same row — that's the real race guard; the pre-check is just a fast-fail.
  // Out-of-stock is now caught HERE instead of first becoming visible at admin
  // approval (Checkout-2/Stock-1 fix, security audit 2026-06-23).
  // releaseOrderHolds (cancel/reject/expire) already returns RESERVED rows to
  // AVAILABLE.
  for (const ci of cart) {
    const available = await countAvailableStock(db, ci.productId);
    if (available < ci.quantity) {
      throw new ValidationError("error.out_of_stock", { product: ci.product.name });
    }
  }
  for (const ci of cart) {
    const unit = q4(unitPrice(ci.product, isReseller));
    for (let k = 0; k < ci.quantity; k++) {
      const reserved = await allocateOneAvailableStock(db, ci.productId, order.id);
      if (!reserved) {
        throw new ValidationError("error.out_of_stock", { product: ci.product.name });
      }
      await db.orderItem.create({
        data: {
          orderId: order.id,
          productId: ci.productId,
          stockItemId: reserved.id,
          quantity: 1,
          unitPrice: unit,
          warrantyDaysSnapshot: (ci.product as unknown as { warrantyDays: number }).warrantyDays,
        },
      });
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

  logger.info(`Created order ${orderCode} for user ${args.user.id} total computed`);
  return getOrder(db, order.id);
}

export async function createOrderDirect(
  db: Db,
  args: {
    user: { id: number; role: string };
    productId: number;
    quantity: number;
    voucherCode?: string | null;
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
  const unit = unitPrice(product, isReseller);
  const subtotal = q4(unit.times(args.quantity));

  // Bulk discount
  let bulkDiscount = ZERO;
  const rule = await getBulkPricingForDenomination(db, args.productId);
  if (rule && args.quantity >= rule.minQuantity) {
    bulkDiscount = q4(subtotal.times(rule.discountPercent).div(100));
  }

  // Voucher
  let voucher = null as Awaited<ReturnType<typeof getVoucherByCode>> | null;
  let voucherDiscount = ZERO;
  if (args.voucherCode) {
    voucher = await getVoucherByCode(db, args.voucherCode);
    if (!voucher) throw new ValidationError("error.voucher_not_found");
    await assertVoucherNotRedeemedByUser(db, voucher.id, args.user.id);
    voucherDiscount = applyVoucherToSubtotal(voucher, subtotal.minus(bulkDiscount));
  }

  const orderCode = await uniqueOrderCode(db);

  // Pre-check before reserving anything (fast-fail on the common "ordered too
  // much" case) — see createOrderFromCart's matching guard for the rationale.
  const available = await countAvailableStock(db, args.productId);
  if (available < args.quantity) {
    throw new ValidationError("error.out_of_stock", { product: product.name });
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
      expiresAt: addMinutes(new Date(), config.PAYMENT_WINDOW_MINUTES),
    },
  });

  // Reserve stock atomically per unit (Checkout-2/Stock-1 fix — see
  // createOrderFromCart's matching loop for the full rationale).
  for (let k = 0; k < args.quantity; k++) {
    const reserved = await allocateOneAvailableStock(db, args.productId, order.id);
    if (!reserved) {
      throw new ValidationError("error.out_of_stock", { product: product.name });
    }
    await db.orderItem.create({
      data: {
        orderId: order.id,
        productId: args.productId,
        stockItemId: reserved.id,
        quantity: 1,
        unitPrice: q4(unit),
        warrantyDaysSnapshot: product.warrantyDays,
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

  const afterDiscount = subtotal.minus(bulkDiscount).minus(voucherDiscount);
  const cents = config.USE_UNIQUE_CENTS ? computeUniqueCents(order.id) : ZERO;
  await db.order.update({
    where: { id: order.id },
    data: { uniqueCents: cents, totalAmount: q4(afterDiscount.plus(cents)) },
  });

  logger.info(
    `Created direct order ${orderCode} user=${args.user.id} product=${args.productId} qty=${args.quantity}`,
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
  // Prevent abuse: fake proof then cancel to recycle stock.
  if (reason === "user_cancelled" && order.status === OrderStatus.PENDING_VERIFICATION) {
    throw new ValidationError("error.cannot_cancel_after_proof");
  }

  await releaseOrderHolds(db, order);
  await db.order.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.CANCELLED,
      adminNote: `${order.adminNote ?? ""}\n[cancel] ${reason}`,
    },
  });
  logger.info(`Cancelled order ${order.orderCode} reason=${reason}`);
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
      status: OrderStatus.CANCELLED,
      adminNote: `${order.adminNote ?? ""}\n[credit_to_balance] ${amount.toString()} ${currency} by admin_id=${args.adminId}`,
    },
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
    `Credited order ${order.orderCode} (${amount.toString()} ${currency}) to buyer's credit balance by admin=${args.adminId}`,
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
  if (order.status !== OrderStatus.PENDING_VERIFICATION) {
    throw new ValidationError("error.order_not_pending_verification");
  }

  await releaseOrderHolds(db, order);
  await db.order.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.REJECTED,
      rejectionReason: args.reason,
      adminNote: `${order.adminNote ?? ""}\n[reject] by admin_id=${args.adminId}: ${args.reason}`,
    },
  });
  logger.info(`Rejected order ${order.orderCode} by admin ${args.adminId}: ${args.reason}`);
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
      details: `code=${order.orderCode}`,
    });
  }

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

  // Enqueue testimoni notification in the same transaction as the status flip.
  // Web-only buyers (telegramId=null) get a "WEB-xx" masked id and the
  // via_website flag so the admin channel post shows the origin.
  const viaWebsite = order.user.telegramId == null;
  const rawId = viaWebsite
    ? `WEB-${(order.user.loginUsername ?? "user").slice(0, 2)}`
    : String(order.user.telegramId);
  const maskedBuyerId = rawId.slice(0, 4) + "X".repeat(Math.max(rawId.length - 4, 3));
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

  logger.info(`Approved + delivered order ${order.orderCode} (admin=${args.adminId})`);
  const refreshed = await getOrder(db, order.id);
  return { order: refreshed!, credentials };
}

// ---- Filtered list/count for the admin web ----

export interface OrderFilter {
  status?: OrderStatus | null;
  userId?: number | null;
  since?: Date | null;
  until?: Date | null;
  orderCode?: string | null;
  voucherId?: number | null;
}

function orderWhere(f: OrderFilter): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (f.status != null) where.status = f.status;
  if (f.userId != null) where.userId = f.userId;
  if (f.orderCode) where.orderCode = { contains: f.orderCode.trim() };
  if (f.voucherId != null) where.voucherId = f.voucherId;
  if (f.since != null || f.until != null) {
    where.createdAt = {};
    if (f.since != null) where.createdAt.gte = f.since;
    if (f.until != null) where.createdAt.lte = f.until;
  }
  return where;
}

export function listOrders(
  db: Db,
  opts: OrderFilter & { limit?: number; offset?: number } = {},
) {
  return db.order.findMany({
    where: orderWhere(opts),
    include: { user: true, items: { include: { product: true } } },
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
