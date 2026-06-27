/**
 * Orders — list/filter, detail, approve/reject. Never sends Telegram messages.
 * Port of routers/orders.py.
 */
import type { FastifyInstance } from "fastify";
import { OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { usdtFromIdr } from "@app/core/formatters";
import {
  prisma,
  approveOrder,
  rejectOrder,
  creditOrderToBalance,
  logAdminAction,
} from "@app/db";
import { csrfProtect } from "../plugins/auth";
import { redirectWithFlash, humanizeValidationError } from "../flash";

const PAGE_SIZE = 50;

/** The Order fields `orderMoneyView` needs — a narrow shape so it stays a
 * plain unit-testable function rather than depending on the full Prisma
 * include shape `getOrder` returns. */
export interface OrderMoneyInput {
  currency: string;
  fxRate: Decimal.Value | null;
  subtotalAmount: Decimal.Value;
  bulkDiscountAmount: Decimal.Value;
  discountAmount: Decimal.Value;
  walletUsed: Decimal.Value;
  uniqueCents: Decimal.Value;
  totalAmount: Decimal.Value;
}

export interface OrderMoneyView {
  currency: string;
  itemsTotal: Decimal;
  /** null = hide the row (the underlying amount is zero). */
  bulkDiscount: Decimal | null;
  discount: Decimal | null;
  walletCredit: Decimal | null;
  amountMarker: Decimal | null;
  totalToPay: Decimal;
  /** IDR equivalent of `totalToPay` for a non-IDR order, via the order's
   * locked fx snapshot — null when the order is IDR or has no snapshot. */
  equivalentIdr: Decimal | null;
}

function hideIfZero(value: Decimal): Decimal | null {
  return value.isZero() ? null : value;
}

/**
 * Shape an order's money fields for display, each expressed in the order's
 * OWN settlement currency (`order.currency`) instead of assuming IDR.
 *
 * `subtotalAmount`/`bulkDiscountAmount`/`discountAmount` are always computed
 * at checkout time from the central-IDR catalog (see `createOrderFromCart` /
 * `createOrderDirect` in packages/db/src/crud/orders.ts) and need converting
 * via the order's locked `fxRate` snapshot when the order settled in a
 * different currency. `walletUsed`/`uniqueCents`/`totalAmount` are already
 * stamped in the order's settlement currency by `finalizeOrderPayment` /
 * `applyUsdtWalletToOrder` — converting them again would double-convert.
 */
export function orderMoneyView(order: OrderMoneyInput): OrderMoneyView {
  const { currency, fxRate } = order;
  const toOrderCurrency = (value: Decimal.Value): Decimal => {
    const v = new Decimal(value);
    return currency === "IDR" || !fxRate ? v : usdtFromIdr(v, fxRate);
  };

  const totalToPay = new Decimal(order.totalAmount);
  const equivalentIdr =
    currency !== "IDR" && fxRate ? totalToPay.times(fxRate) : null;

  return {
    currency,
    itemsTotal: toOrderCurrency(order.subtotalAmount),
    bulkDiscount: hideIfZero(toOrderCurrency(order.bulkDiscountAmount)),
    discount: hideIfZero(toOrderCurrency(order.discountAmount)),
    walletCredit: hideIfZero(new Decimal(order.walletUsed)),
    amountMarker: hideIfZero(new Decimal(order.uniqueCents)),
    totalToPay,
    equivalentIdr,
  };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const STATUS_VALUES = Object.values(OrderStatus) as string[];

export default async function ordersRoutes(app: FastifyInstance): Promise<void> {
  // ---- Orders list + order detail: migrated to React SPA (api/orders.ts) ----
  // GET /orders  →  served by SPA shell (OrdersPage)
  // GET /orders/:orderId  →  served by SPA shell (OrderDetailPage)

  app.post("/orders/:orderId/approve", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      await prisma.$transaction(async (tx) => {
        const { order } = await approveOrder(tx, orderId, { adminId: req.admin!.userId });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "approve_order",
          targetType: "order",
          targetId: orderId,
          details: `Approved order ${order.orderCode}.`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, `/orders/${orderId}`, humanizeValidationError(e), "error");
      }
      throw e;
    }
    // NB: never put credentials in the redirect URL — they'd leak into logs.
    logger.info(`Admin ${req.admin!.userId} approved and delivered order ${orderId} via the web panel`);
    return redirectWithFlash(
      reply,
      `/orders/${orderId}`,
      "Order approved and delivered. Credentials are shown below.",
      "success",
    );
  });

  app.post("/orders/:orderId/credit-balance", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    try {
      await prisma.$transaction(async (tx) => {
        const { credited, currency } = await creditOrderToBalance(tx, {
          orderId,
          adminId: req.admin!.userId,
        });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "order_credit_balance",
          targetType: "order",
          targetId: orderId,
          details: `Credited order ${orderId}'s paid amount (${credited.toString()} ${currency}) to the buyer's balance.`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, `/orders/${orderId}`, humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} credited order ${orderId}'s paid amount to the buyer's balance via the web panel`);
    return redirectWithFlash(
      reply,
      `/orders/${orderId}`,
      "Paid amount added to the buyer's credit balance.",
      "success",
    );
  });

  app.post("/orders/:orderId/reject", { preHandler: csrfProtect }, async (req, reply) => {
    const orderId = Number((req.params as { orderId: string }).orderId);
    const reason = ((req.body as Record<string, string>).reason ?? "").trim();
    if (!reason) {
      return redirectWithFlash(reply, `/orders/${orderId}`, "A rejection reason is required.", "error");
    }
    try {
      await prisma.$transaction(async (tx) => {
        await rejectOrder(tx, orderId, { adminId: req.admin!.userId, reason });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "reject_order",
          targetType: "order",
          targetId: orderId,
          details: `Rejected order ${orderId}: ${reason.slice(0, 200)}`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return redirectWithFlash(reply, `/orders/${orderId}`, humanizeValidationError(e), "error");
      }
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} rejected order ${orderId} via the web panel`);
    return redirectWithFlash(reply, `/orders/${orderId}`, "Order rejected.", "success");
  });
}
