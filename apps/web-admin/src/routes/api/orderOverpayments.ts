/**
 * Admin API for returning an overpayment (task F2) — the caller
 * `postOverpaymentCreditPosting` shipped without (decision D3).
 *
 * WIRING ONLY. The amount, every guard and the audit row live in
 * `packages/db/src/crud/overpayments.ts`: `creditOverpaymentToBalance` derives the
 * excess from the rail's own processed-transaction row, credits it with
 * `adjustWallet`, posts it with `postOverpaymentCreditPosting` and writes its own
 * `logAdminAction`, all in one transaction. This handler parses the path and
 * reports what moved. It deliberately does NOT audit again, matching
 * stockReplacements.ts: a second row would double-log one admin action.
 *
 * ## The request body carries no amount, on purpose
 *
 * This is the whole point of the task and the one thing a route could get wrong
 * that no ledger check would catch. An excess accepted from the client is an
 * excess an admin (or a crafted request) can set to any number, with the rail's
 * own record silently disagreeing and the ledger still balancing perfectly — the
 * exact class of error a double-entry system cannot find. So there is nothing to
 * parse here but the order id, and the service refuses an order no rail flagged
 * rather than crediting a figure it was handed.
 *
 * ## Why /api/orders/:orderId/… and not a new prefix
 *
 * Mutation RBAC is prefix-driven and defaults to deny (`OPS_PREFIXES` /
 * `CONFIG_PREFIXES`, plugins/auth.ts), so a new top-level prefix would silently
 * become super-admin-only. `/api/orders` is an OPS prefix, which puts this at
 * `super` + `support` — matching `/api/payments/order/:id/credit-anyway`, the
 * existing route that credits a wallet from a rail-recorded amount for an
 * underpaid top-up. That precedent is what makes support-tier right here rather
 * than a widening: both hand back money a gateway really collected, in an amount
 * the admin cannot choose. A hand-made wallet adjustment — where the admin DOES
 * choose the amount — stays super-only under `/api/users`, and this route does
 * not change that.
 *
 * ## No Idempotency-Key here
 *
 * A replayed request needs no stored response: `wallet_transactions` is UNIQUE on
 * `(orderId, reason)` and this credit has its own reason code, so a second call —
 * double click, retried fetch, two admins at once — is rejected by the database
 * before any balance moves and comes back 422 "already credited". The failure mode
 * is a redundant message, never a second credit.
 */
import type { FastifyInstance } from "fastify";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import { logger } from "@app/core/logger";
import { prisma, creditOverpaymentToBalance } from "@app/db";
import { csrfProtect } from "../../plugins/auth";

/** A positive integer route param, or null when it isn't one. */
function idParam(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function orderOverpaymentsApiRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/orders/:orderId/credit-overpayment",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const orderId = idParam((req.params as { orderId: string }).orderId);
      if (orderId === null) return reply.code(400).send({ error: "Invalid order id." });

      try {
        const { credited, currency } = await creditOverpaymentToBalance(prisma, {
          orderId,
          adminId: req.admin!.userId,
        });
        logger.info(
          `Admin ${req.admin!.userId} returned the ${credited.toString()} ${currency} overpaid on order ${orderId} to the buyer's wallet balance via the web panel`,
        );
        // The amount goes back to the browser so the panel can name what actually
        // moved rather than showing a green toast with no figure in it — the admin
        // never chose this number and has no other way to see it.
        return reply.send({ ok: true, credited: credited.toString(), currency });
      } catch (e) {
        if (e instanceof ValidationError) {
          return reply.code(422).send(errorBody(e));
        }
        throw e;
      }
    },
  );
}
