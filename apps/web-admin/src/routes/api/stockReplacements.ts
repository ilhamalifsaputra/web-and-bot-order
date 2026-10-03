/**
 * Admin API for account/stock replacement — "the account you sold me is dead"
 * (Financial Ledger M20, the admin surface over M19's service).
 *
 * WIRING ONLY. Every guard, every amount and every audit line lives in
 * `packages/db/src/crud/stockReplacement.ts`: `replaceStockItem` decides
 * whether a unit may be replaced at all, `retryReplacementAllocation` decides
 * whether a parked request may try again, and `refundInsteadOfReplace` works
 * out what one unit is really worth and pays it out through `executeRefund`.
 * These handlers parse, authorize the path, call one of those three, and shape
 * the answer. Nothing here recomputes a refund, checks an order status, or
 * writes to `stock_replacements`.
 *
 * All three service functions write their own `logAdminAction` row, so — like
 * the `/fulfill` route in orders.ts — this file deliberately does NOT audit
 * again; a second row would double-log the one action an admin took.
 *
 * ## Why these live under /api/orders/…
 *
 * Not `/api/stock-replacements/…`: mutation RBAC is prefix-driven
 * (`OPS_PREFIXES`/`CONFIG_PREFIXES` in plugins/auth.ts) and defaults to deny,
 * so a brand-new top-level prefix would silently become super-admin-only and
 * lock the support role out of a complaint it is otherwise expected to handle.
 * Nesting under the order these requests are always about keeps the existing
 * `/api/orders` operational grant, and makes the order id in the path a real
 * authorization check rather than decoration — see `unitOfOrder` /
 * `replacementOfOrder` below, which refuse a unit or request belonging to some
 * other order instead of quietly acting on it.
 *
 * ## No Idempotency-Key here
 *
 * Unlike the payment mutations (routes/api/payments.ts), a replayed request
 * needs no stored response: each of the three service calls is guarded by a
 * status claim, so a double-clicked button loses the race and comes back 422
 * ("already open" / "not awaiting stock") having changed nothing. The failure
 * mode is a confusing message, never a second credential handed out or a
 * second payout.
 */
import type { FastifyInstance } from "fastify";
import { parsePositiveId } from "../../lib/params";
import { RefundExecutionMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import { logger } from "@app/core/logger";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import {
  prisma,
  getOrder,
  getTicket,
  listStockReplacementsForOrder,
  refundInsteadOfReplace,
  replaceStockItem,
  retryReplacementAllocation,
} from "@app/db";
import { csrfProtect } from "../../plugins/auth";

const REFUND_METHODS = Object.values(RefundExecutionMethod) as string[];

/** A positive integer route param (plain digits, within the DB id range), or null when it isn't one. */
const idParam = (raw: string | undefined): number | null => parsePositiveId(raw);

/** Trimmed string body field, or null when absent/blank — an admin's optional
 *  free text should never be stored as `""` or as the string "undefined". */
function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The order item `orderItemId` names, but only if it really is a unit of
 * `orderId`. Returns null otherwise, which every caller turns into a 404: a
 * request naming one order and another order's unit is not a unit this URL is
 * allowed to act on.
 */
async function unitOfOrder(orderId: number, orderItemId: number) {
  const order = await getOrder(prisma, orderId);
  if (!order) return null;
  return order.items.find((item) => item.id === orderItemId) ?? null;
}

/** Same check for a replacement request: the request, but only if it belongs to
 *  a unit of `orderId`. Read through the crud layer, not a route-level query. */
async function replacementOfOrder(orderId: number, replacementId: number) {
  const rows = await listStockReplacementsForOrder(prisma, orderId);
  return rows.find((row) => row.id === replacementId) ?? null;
}

export default async function stockReplacementApiRoutes(app: FastifyInstance): Promise<void> {
  // Record that one delivered unit was bad and replace it if the shop can.
  // Per unit, never per order: one OrderItem row IS one purchased unit (see
  // the StockReplacement schema comment), so "unit 3 of 5 is dead" needs no
  // quantity and no index.
  app.post(
    "/api/orders/:orderId/items/:orderItemId/replace",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const params = req.params as { orderId: string; orderItemId: string };
      const orderId = idParam(params.orderId);
      const orderItemId = idParam(params.orderItemId);
      if (orderId === null || orderItemId === null) {
        return reply.code(400).send({ error: "Invalid order or item id." });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = optionalText(body.reason);
      if (!reason) {
        return reply
          .code(400)
          .send({ error: "A description of what was wrong with the account is required." });
      }
      const notes = optionalText(body.notes);

      // Optional link to the ticket the complaint arrived on — validated here
      // so a bad id comes back as a 404 instead of a foreign-key crash.
      let supportTicketId: number | null = null;
      if (body.supportTicketId != null) {
        supportTicketId = idParam(String(body.supportTicketId));
        if (supportTicketId === null) return reply.code(400).send({ error: "Invalid ticket id." });
        const ticket = await getTicket(prisma, supportTicketId);
        if (!ticket) {
          return reply.code(404).send({ error: "Ticket not found." });
        }
        // The ticket must be about THIS order. Existence alone is not enough:
        // `StockReplacement.supportTicketId` is what an admin later reads to see
        // why a credential was replaced, and a request stamped with an unrelated
        // ticket sends that reader to another buyer's complaint. Only an exact
        // match passes — a ticket with NO order link is refused too, because
        // there is nothing to check it against and the only caller that sends
        // this field (the ticket detail page, which renders the unit list solely
        // for a ticket's own linked order) never has one.
        if (ticket.orderId !== orderId) {
          return reply.code(400).send({
            error: "That support ticket is not about this order, so it cannot be linked to the replacement.",
          });
        }
      }

      const unit = await unitOfOrder(orderId, orderItemId);
      if (!unit) return reply.code(404).send({ error: "This order has no such item." });

      try {
        const { replacement, replacementStockItem, buyerNotified } = await replaceStockItem(prisma, {
          orderItemId,
          reason,
          executedBy: req.admin!.userId,
          supportTicketId,
          notes,
        });
        if (buyerNotified) {
          // The service put a row in the outbox for the buyer; wake the
          // dispatcher rather than waiting out its poll interval, exactly as
          // the /resend route does after its own enqueue. Nothing to wake when
          // the buyer was unreachable — no row was written.
          nudgeOutboxDispatcher();
        }
        logger.info(
          `Admin ${req.admin!.userId} recorded a bad account on order ${orderId} item ${orderItemId} via the web panel; stock replacement ${replacement.id} is now ${replacement.status}`,
        );
        return reply.send({
          ok: true,
          replacementId: replacement.id,
          status: replacement.status,
          credentialIssued: replacementStockItem !== null,
          // Reported separately from `credentialIssued` on purpose: a buyer with
          // no Telegram id and no guest email gets the new credential but no
          // message about it, and the panel must say so rather than claim it was
          // sent (see the service's `buyerNotified`).
          buyerNotified,
        });
      } catch (e) {
        if (e instanceof ValidationError) {
          return reply.code(422).send(errorBody(e));
        }
        throw e;
      }
    },
  );

  // Try again to issue a replacement for a request parked at AWAITING_STOCK,
  // once the SKU has been restocked. This button IS the retry mechanism —
  // nothing sweeps these rows in the background (M19's own design).
  app.post(
    "/api/orders/:orderId/replacements/:replacementId/retry",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const params = req.params as { orderId: string; replacementId: string };
      const orderId = idParam(params.orderId);
      const replacementId = idParam(params.replacementId);
      if (orderId === null || replacementId === null) {
        return reply.code(400).send({ error: "Invalid order or replacement id." });
      }
      if (!(await replacementOfOrder(orderId, replacementId))) {
        return reply.code(404).send({ error: "This order has no such replacement request." });
      }

      try {
        const { replacement, replacementStockItem, buyerNotified } = await retryReplacementAllocation(
          prisma,
          { stockReplacementId: replacementId, executedBy: req.admin!.userId },
        );
        if (buyerNotified) nudgeOutboxDispatcher();
        logger.info(
          replacementStockItem
            ? `Admin ${req.admin!.userId} cleared stock replacement ${replacementId} on order ${orderId} via the web panel: a restocked account has been handed over, and the buyer ${buyerNotified ? "has been queued a message about it" : "could not be told about it, having neither a Telegram id nor a guest email address"}`
            : `Admin ${req.admin!.userId} retried stock replacement ${replacementId} on order ${orderId} via the web panel, but the denomination is still out of stock, so the buyer is still waiting`,
        );
        return reply.send({
          ok: true,
          status: replacement.status,
          credentialIssued: replacementStockItem !== null,
          buyerNotified,
        });
      } catch (e) {
        if (e instanceof ValidationError) {
          return reply.code(422).send(errorBody(e));
        }
        throw e;
      }
    },
  );

  // Stop waiting for a restock and give the buyer their money back for this
  // one unit. The amount is the service's to decide (it prorates order-level
  // discounts and converts through the order's own FX snapshot) — this route
  // only carries the payout method the admin chose and reports what moved.
  app.post(
    "/api/orders/:orderId/replacements/:replacementId/refund",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const params = req.params as { orderId: string; replacementId: string };
      const orderId = idParam(params.orderId);
      const replacementId = idParam(params.replacementId);
      if (orderId === null || replacementId === null) {
        return reply.code(400).send({ error: "Invalid order or replacement id." });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Defaults to WALLET, the method this fallback is shaped around (a
      // wallet credit is instant, and by now the buyer has waited long
      // enough). MANUAL_TRANSFER stays reachable for a shop that pays back out
      // of band; its proof requirement is enforced by `executeRefund`, which
      // is why an unproven transfer comes back 422 rather than being
      // second-guessed here.
      const method = optionalText(body.method) ?? RefundExecutionMethod.WALLET;
      if (!REFUND_METHODS.includes(method)) {
        return reply.code(400).send({ error: "Unknown refund method." });
      }
      if (!(await replacementOfOrder(orderId, replacementId))) {
        return reply.code(404).send({ error: "This order has no such replacement request." });
      }

      try {
        const { execution } = await refundInsteadOfReplace(prisma, {
          stockReplacementId: replacementId,
          executedBy: req.admin!.userId,
          method,
          reference: optionalText(body.reference),
          // Never logged anywhere below — a payment-proof file id is a secret
          // (CLAUDE.md), and the pino line under this only names amounts.
          proofFileId: optionalText(body.proofFileId),
          notes: optionalText(body.notes),
        });
        logger.info(
          `Admin ${req.admin!.userId} refunded ${execution.amount.toString()} ${execution.currency} for one unit of order ${orderId} by ${execution.method} via the web panel instead of replacing a bad account, closing stock replacement ${replacementId}`,
        );
        return reply.send({
          ok: true,
          refunded: execution.amount.toString(),
          currency: execution.currency,
        });
      } catch (e) {
        if (e instanceof ValidationError) {
          return reply.code(422).send(errorBody(e));
        }
        throw e;
      }
    },
  );
}
