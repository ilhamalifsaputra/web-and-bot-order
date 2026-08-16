/**
 * CRUD for the Digiflazz-backed "Top Up Game" instant-checkout pilot —
 * plan for the checkoutFlow="instant" category (schema.prisma Category
 * .checkoutFlow, Denomination.autoDeliverySource/.supplierSku,
 * Order.digiflazzDispatchedAt).
 *
 * The HTTP/signature side (request shapes, MD5 signing) lives in
 * @app/core/suppliers/digiflazz; this module only mutates the DB and decides
 * when to call it. Mirrors crud/tokopay.ts's split between the two layers.
 *
 * Three responsibilities:
 *  - getDigiflazzCreds       — read the gateway credentials from Settings.
 *  - dispatchPendingDigiflazzOrders — the poller: find PROCESSING orders
 *    routed to Digiflazz and not yet dispatched, claim them one at a time,
 *    and place the top-up order with the supplier.
 *  - fulfillDigiflazzOrder   — the twin of orders.ts's fulfillManualOrder,
 *    for the "Sukses" (and later, webhook-driven) case: flips the order to
 *    DELIVERED and runs the same shared side effects a manually-fulfilled
 *    order gets.
 */
import { OrderStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { ValidationError } from "@app/core/errors";
import { parseAdditionalFields, parseCustomerData } from "@app/core/deliveryFields";
import { createTransaction, type DigiflazzCreds } from "@app/core/suppliers/digiflazz";
import type { PrismaClient } from "../client";
import type { Db } from "./_types";
import { getSetting } from "./settings";
import { getOrder, finalizeDeliverySideEffects } from "./orders";
import { enqueueManualOrderAdminAlert, enqueueManualDeliveredDm } from "./notifications";
import { logAdminAction } from "./audit";

/** Setting keys — not yet wired to any admin UI (a later task adds that);
 * this module is only the read-side resolver, matching the shape every other
 * `getXCreds` sibling (e.g. getTokopayCreds) already uses. */
export const DIGIFLAZZ_USERNAME_KEY = "digiflazz_username";
export const DIGIFLAZZ_API_KEY_KEY = "digiflazz_api_key";
export const DIGIFLAZZ_ENABLED_KEY = "digiflazz_enabled";

/** Read Digiflazz supplier credentials from Settings; null = the Digiflazz
 * auto-fulfilment path is off (either not configured, or explicitly
 * disabled). Mirrors getTokopayCreds's null-on-disabled-or-missing shape. */
export async function getDigiflazzCreds(db: Db): Promise<DigiflazzCreds | null> {
  const [username, apiKey, enabled] = await Promise.all([
    getSetting(db, DIGIFLAZZ_USERNAME_KEY),
    getSetting(db, DIGIFLAZZ_API_KEY_KEY),
    getSetting(db, DIGIFLAZZ_ENABLED_KEY),
  ]);
  if (!username || !apiKey) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return { username, apiKey };
}

/**
 * Format one order's buyer-supplied answers (Order.customerData — one
 * {fieldKey: answer} map per unit, see @app/core/deliveryFields) into the
 * `customer_no` string Digiflazz expects for this denomination's SKU.
 *
 * ⚠ ASSUMPTION: Digiflazz's real per-SKU customer_no format (a single game
 * id vs. a combined "id server" pair, and the exact separator) isn't
 * knowable generically from this repo — this joins every non-empty answer
 * for the order's first unit, in the SKU's field-definition order, with a
 * single space. Reasonable pilot default, NOT a verified Digiflazz
 * convention; may need per-SKU customization once real SKUs are onboarded
 * (see the ⚠ ASSUMPTION notes throughout @app/core/suppliers/digiflazz for
 * the same caveat on the wire format itself).
 */
export function buildDigiflazzCustomerNo(
  product: { additionalFields: string | null },
  customerDataJson: string | null,
): string {
  const fields = parseAdditionalFields(product.additionalFields);
  const unit = parseCustomerData(customerDataJson)[0] ?? {};
  return fields
    .map((field) => unit[field.key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join(" ");
}

/** Minimal shape dispatchPendingDigiflazzOrders needs per candidate order —
 * a narrower include than orders.ts's full getOrder, since the poller only
 * needs enough to place the supplier order and, on failure, alert admins. */
type DigiflazzCandidateOrder = {
  id: number;
  orderCode: string;
  customerData: string | null;
  totalAmount: unknown;
  currency: string;
  items: {
    quantity: number;
    product: {
      name: string;
      supplierSku: string | null;
      additionalFields: string | null;
    };
  }[];
};

/** Tally of one dispatchPendingDigiflazzOrders pass, for the caller (a later
 * task's cron job) to log. */
export interface DigiflazzDispatchSummary {
  /** Candidate orders this call won the atomic claim on and actually called
   * Digiflazz for (excludes orders a concurrent/earlier tick already claimed). */
  claimed: number;
  /** Of the claimed orders, how many Digiflazz reported "Sukses" for and
   * were fulfilled (DELIVERED) in this same pass. */
  delivered: number;
  /** Of the claimed orders, how many Digiflazz reported "Pending" for — left
   * PROCESSING, awaiting the webhook callback (a later task) to finish them. */
  pending: number;
  /** Of the claimed orders, how many failed — either Digiflazz reported
   * "Gagal", the SKU had no supplierSku configured, or the HTTP call itself
   * threw. Each of these enqueued an admin alert and left the order
   * PROCESSING for a human to finish via fulfillManualOrder. */
  failed: number;
}

const ZERO_SUMMARY: DigiflazzDispatchSummary = { claimed: 0, delivered: 0, pending: 0, failed: 0 };

/**
 * Enqueue the "needs a human" admin alert for an order this poller could not
 * auto-fulfil via Digiflazz (SKU missing supplierSku, Digiflazz reported
 * "Gagal", or the HTTP call itself threw) — same channel/shape
 * fulfillManualOrder's own admin alert already uses
 * (enqueueManualOrderAdminAlert, ADMIN_MANUAL_ORDER_QUEUED), since the
 * remedy is identical: a human finishes the order via the existing
 * fulfillManualOrder path. Also writes an AuditLog row (system actor, no
 * human admin id) so there's a forensic trail for why an order that reached
 * PROCESSING never auto-delivered.
 */
async function alertDigiflazzDispatchFailed(
  db: Db,
  order: DigiflazzCandidateOrder,
  reason: string,
): Promise<void> {
  await enqueueManualOrderAdminAlert(db, {
    orderId: order.id,
    orderCode: order.orderCode,
    items: order.items.map((item) => ({ name: item.product.name, qty: item.quantity })),
    total: order.totalAmount as never,
    currency: order.currency,
  });
  await logAdminAction(db, {
    adminId: null,
    action: "order.digiflazz_dispatch_failed",
    targetType: "order",
    targetId: order.id,
    details: `Digiflazz gagal — perlu ditangani manual. Order ${order.orderCode}: ${reason}`,
  });
  logger.warn(
    `Digiflazz dispatch failed for order ${order.orderCode} (${reason}) — queued for manual fulfilment and alerted admins`,
  );
}

/**
 * The Digiflazz dispatch poller. Finds PROCESSING orders whose item routes to
 * Digiflazz (denomination.autoDeliverySource === "digiflazz") and haven't been
 * dispatched yet (digiflazzDispatchedAt IS NULL), claims each one atomically
 * (same updateMany-with-status-guard shape fulfillManualOrder's own claim
 * uses, applied to the dispatch step instead of the delivery step — see
 * Order.digiflazzDispatchedAt's doc comment in schema.prisma), and places the
 * top-up order with Digiflazz.
 *
 * No-op (returns the zero summary, touches nothing) if Digiflazz isn't
 * configured — never claims orders it can't actually dispatch.
 *
 * Each candidate is claimed and dispatched one at a time (not batched inside
 * one transaction): SQLite has one writer, and a supplier HTTP round-trip
 * inside a long-held transaction would starve every other writer, so the
 * atomic claim is its own short write and the HTTP call happens outside it —
 * same reasoning as enqueueFlashSaleBroadcast's chunking.
 */
export async function dispatchPendingDigiflazzOrders(db: PrismaClient): Promise<DigiflazzDispatchSummary> {
  const creds = await getDigiflazzCreds(db);
  if (!creds) return ZERO_SUMMARY;

  const candidates: DigiflazzCandidateOrder[] = await db.order.findMany({
    where: {
      status: OrderStatus.PROCESSING,
      digiflazzDispatchedAt: null,
      items: { some: { product: { autoDeliverySource: "digiflazz" } } },
    },
    include: {
      items: {
        include: { product: { select: { name: true, supplierSku: true, additionalFields: true } } },
      },
    },
  });

  const summary: DigiflazzDispatchSummary = { claimed: 0, delivered: 0, pending: 0, failed: 0 };

  for (const order of candidates) {
    // Atomic claim: only proceed to call Digiflazz if THIS call wins the
    // race (count === 1). A concurrent tick, a restarted poller, or a retry
    // that re-fetched the same candidate list all lose here instead of
    // double-dispatching the same order to the supplier.
    const claim = await db.order.updateMany({
      where: { id: order.id, status: OrderStatus.PROCESSING, digiflazzDispatchedAt: null },
      data: { digiflazzDispatchedAt: new Date() },
    });
    if (claim.count !== 1) continue;
    summary.claimed++;

    const item = order.items[0];
    const supplierSku = item?.product.supplierSku;
    if (!item || !supplierSku) {
      await alertDigiflazzDispatchFailed(db, order, "the SKU has no supplierSku configured");
      summary.failed++;
      continue;
    }

    const customerNo = buildDigiflazzCustomerNo(item.product, order.customerData);

    try {
      const result = await createTransaction(creds, {
        refId: order.orderCode,
        buyerSkuCode: supplierSku,
        customerNo,
      });

      if (result.status === "Sukses") {
        await fulfillDigiflazzOrder(db, order.id, { sn: result.sn ?? "" });
        summary.delivered++;
        logger.info(`Digiflazz auto-delivered order ${order.orderCode} (buyerSkuCode ${supplierSku})`);
      } else if (result.status === "Pending") {
        summary.pending++;
        logger.info(
          `Digiflazz order ${order.orderCode} (buyerSkuCode ${supplierSku}) is Pending — left PROCESSING, awaiting the supplier's final report`,
        );
      } else {
        await alertDigiflazzDispatchFailed(
          db,
          order,
          `Digiflazz reported Gagal${result.message ? ` (${result.message})` : ""}`,
        );
        summary.failed++;
      }
    } catch (err) {
      // The HTTP call itself failed (network error, timeout, malformed
      // response — see @app/core/suppliers/digiflazz's fetchDigiflazzJson).
      // The claim above already committed, so this order will never be
      // retried by this poller — whether Digiflazz actually placed the order
      // is now unknown, so this can only be resolved by a human, same as an
      // explicit "Gagal". err's message is already credential-free (the
      // client's own guarantee); never log err.cause or the request body.
      const message = err instanceof Error ? err.message : String(err);
      await alertDigiflazzDispatchFailed(db, order, `the request to Digiflazz failed (${message})`);
      summary.failed++;
    }
  }

  return summary;
}

/**
 * Auto-fulfilment: Digiflazz reported "Sukses" (or, in a later task, its
 * webhook callback reports the same for a previously-Pending order). A twin
 * of orders.ts's fulfillManualOrder — same atomic PROCESSING -> DELIVERED
 * claim, same OrderStatusHistory write, same shared
 * finalizeDeliverySideEffects (referral commission, testimonial post,
 * bulk-purchase broadcast) — but the "content" delivered to the buyer is the
 * supplier's serial number rather than admin-typed text, and the actor
 * audited is the system, not a human admin.
 *
 * Reuses enqueueManualDeliveredDm/ORDER_MANUAL_DELIVERED_DM for the buyer DM
 * rather than a new event: that event's dispatcher already renders
 * Order.deliveredContent live at send time and never puts the content itself
 * in the outbox payload — exactly the shape this needs for the SN receipt.
 */
export async function fulfillDigiflazzOrder(
  db: Db,
  orderId: number,
  args: { sn: string },
) {
  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");

  const now = new Date();
  const claim = await db.order.updateMany({
    where: { id: orderId, status: OrderStatus.PROCESSING },
    data: { status: OrderStatus.DELIVERED, deliveredContent: args.sn, deliveredAt: now },
  });
  if (claim.count !== 1) throw new ValidationError("error.order_not_processing");
  await db.orderStatusHistory.create({
    data: { orderId, status: OrderStatus.DELIVERED, meta: "digiflazz_fulfill" },
  });

  await finalizeDeliverySideEffects(db, order, now);

  await enqueueManualDeliveredDm(db, {
    orderId,
    orderCode: order.orderCode,
    telegramId: order.user.telegramId,
    language: order.user.language,
  });

  await logAdminAction(db, {
    adminId: null,
    action: "order.auto_fulfill_digiflazz",
    targetType: "order",
    targetId: order.id,
    details: `Auto-fulfilled Digiflazz order ${order.orderCode} and sent the receipt to the buyer.`,
  });

  logger.info(`Auto-fulfilled Digiflazz order ${order.orderCode}`);
  const refreshed = await getOrder(db, orderId);
  return { order: refreshed! };
}
