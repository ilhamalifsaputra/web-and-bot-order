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
import { getBulkPricingForProduct } from "./catalog";
import { getVoucherByCode, applyVoucherToSubtotal } from "./vouchers";
import { countAvailableStock, allocateOneAvailableStock } from "./stock";
import { adjustWallet, getUser } from "./users";
import { clearCart, getCart } from "./cart";
import { maybePayReferralCommission } from "./referrals";
import { enqueueNotification } from "./notifications";

const ZERO = new Decimal(0);
const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

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

  const isReseller = args.user.role === UserRole.RESELLER;

  // 1. Subtotal
  let subtotal = ZERO;
  for (const ci of cart) {
    subtotal = subtotal.plus(unitPrice(ci.product, isReseller).times(ci.quantity));
  }

  // 2. Bulk discount
  const bulkRules: Record<number, BulkRule> = {};
  for (const ci of cart) {
    const rule = await getBulkPricingForProduct(db, ci.productId);
    if (rule) bulkRules[ci.productId] = rule;
  }
  const bulkDiscount = computeBulkDiscountForCart(cart, bulkRules, isReseller);

  // 3. Voucher
  let discount = ZERO;
  let voucher = null as Awaited<ReturnType<typeof getVoucherByCode>> | null;
  if (args.voucherCode) {
    voucher = await getVoucherByCode(db, args.voucherCode);
    if (!voucher) throw new ValidationError("error.voucher_not_found");
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

  // 7. Validate stock & create one OrderItem per unit (no reservation yet)
  for (const ci of cart) {
    const available = await countAvailableStock(db, ci.productId);
    if (available < ci.quantity) {
      throw new ValidationError("error.out_of_stock", { product: ci.product.name });
    }
    const unit = q4(unitPrice(ci.product, isReseller));
    for (let k = 0; k < ci.quantity; k++) {
      await db.orderItem.create({
        data: {
          orderId: order.id,
          productId: ci.productId,
          stockItemId: null,
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

  // 9. Wallet debit (atomic)
  if (walletUsed.greaterThan(0)) {
    await adjustWallet(db, args.user.id, walletUsed.negated(), { reason: "order_payment", orderId: order.id });
  }

  // 10. Bump voucher usage
  if (voucher) {
    await db.voucher.update({
      where: { id: voucher.id },
      data: { usedCount: { increment: 1 } },
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
  const product = await db.product.findUnique({ where: { id: args.productId } });
  if (!product) throw new ValidationError("error.out_of_stock", { product: "(unknown)" });

  const isReseller = args.user.role === UserRole.RESELLER;
  const unit = unitPrice(product, isReseller);
  const subtotal = q4(unit.times(args.quantity));

  // Bulk discount
  let bulkDiscount = ZERO;
  const rule = await getBulkPricingForProduct(db, args.productId);
  if (rule && args.quantity >= rule.minQuantity) {
    bulkDiscount = q4(subtotal.times(rule.discountPercent).div(100));
  }

  // Voucher
  let voucher = null as Awaited<ReturnType<typeof getVoucherByCode>> | null;
  let voucherDiscount = ZERO;
  if (args.voucherCode) {
    voucher = await getVoucherByCode(db, args.voucherCode);
    if (!voucher) throw new ValidationError("error.voucher_not_found");
    voucherDiscount = applyVoucherToSubtotal(voucher, subtotal.minus(bulkDiscount));
  }

  const orderCode = await uniqueOrderCode(db);

  // Validate stock before committing
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

  for (let k = 0; k < args.quantity; k++) {
    await db.orderItem.create({
      data: {
        orderId: order.id,
        productId: args.productId,
        stockItemId: null,
        quantity: 1,
        unitPrice: q4(unit),
        warrantyDaysSnapshot: product.warrantyDays,
      },
    });
  }

  if (voucher) {
    await db.voucher.update({
      where: { id: voucher.id },
      data: { usedCount: { increment: 1 } },
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
    await adjustWallet(db, order.userId, order.walletUsed, { allowNegative: true, reason: "order_refund", orderId: order.id });
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
  if (order.status !== OrderStatus.PENDING_VERIFICATION) {
    throw new ValidationError("error.order_not_pending_verification");
  }

  const now = new Date();
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
      status: OrderStatus.DELIVERED,
      paidAt: now,
      deliveredAt: now,
      adminNote: `${order.adminNote ?? ""}\n[approve] by admin_id=${args.adminId}`,
    },
  });

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
