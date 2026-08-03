/**
 * JSON checkout + pay endpoints for the React SPA — twins of the HTML/HTMX
 * handlers in routes/checkout.ts, reusing the SAME exported helpers
 * (checkoutView / payView / payState / performCheckout) so there is exactly
 * one implementation of checkout's business rules. The order-creating POST
 * /api/v1/checkout already exists in routes/api.ts (extended there with the
 * wallet flags); the three payment webhooks stay in routes/checkout.ts
 * untouched.
 *
 * Auth: cookie session. Reads 401 as JSON (the SPA redirects to /login);
 * mutations additionally require the x-csrf-token header — the same
 * currentCustomer/csrfCheck semantics as the HTML routes, but JSON-shaped
 * instead of a 303 redirect.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "@app/core/errors";
import { prisma, getOrderByCode, cancelOrder } from "@app/db";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { checkoutView, payView, payState } from "./checkout";
import { constantTimeEqual } from "../auth";

/** JSON-flavored auth gate: 401 body instead of the HTML routes' 303. */
async function requireCustomer(req: FastifyRequest, reply: FastifyReply): Promise<Customer | null> {
  const customer = await optionalCustomer(req);
  if (!customer) {
    void reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return customer;
}

/** x-csrf-token header check for signed-in JSON mutations. */
function csrfHeaderOk(req: FastifyRequest, customer: Customer): boolean {
  const token = req.headers["x-csrf-token"];
  return typeof token === "string" && constantTimeEqual(token, customer.csrf);
}

const apiCheckoutRoutes: FastifyPluginAsync = async (app) => {
  // ---- Checkout summary + method availability ----
  app.get("/checkout", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    return reply.send(await checkoutView(req, customer, null, null));
  });

  // ---- Voucher preview: recompute totals WITHOUT creating an order ----
  app.post<{ Body: { voucher_code?: string } }>("/checkout/voucher/preview", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }
    const voucherCode = (req.body?.voucher_code ?? "").trim().toUpperCase() || null;
    return reply.send(await checkoutView(req, customer, voucherCode, null));
  });

  // ---- Pay page data (gateway payloads, state flags, countdown anchor) ----
  app.get<{ Params: { code: string } }>("/orders/:code/pay", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const order = await getOrderByCode(prisma, req.params.code);
    // Ownership check — 404 (not 403) so codes can't be probed.
    if (!order || order.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(await payView(order));
  });

  // ---- Status poll (the SPA polls every 5s; redirect set once delivered) ----
  app.get<{ Params: { code: string } }>("/orders/:code/status", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const order = await getOrderByCode(prisma, req.params.code);
    if (!order || order.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const state = payState(order);
    return reply.send({
      state,
      // Once delivered, the SPA navigates to the credentials page — the JSON
      // twin of the HTMX HX-Redirect header.
      redirect: state === "delivered" ? `/account/orders/${order.orderCode}` : null,
    });
  });

  // ---- Buyer cancels a still-pending order ----
  app.post<{ Params: { code: string } }>("/orders/:code/cancel", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }
    const order = await getOrderByCode(prisma, req.params.code);
    if (order && order.userId === customer.userId) {
      try {
        await prisma.$transaction((tx) => cancelOrder(tx, order.id, "user_cancelled"));
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e; // already paid/delivered → just bounce
      }
    }
    return reply.send({ ok: true });
  });
};

export default apiCheckoutRoutes;
