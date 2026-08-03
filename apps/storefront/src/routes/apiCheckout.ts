/**
 * JSON checkout + pay endpoints for the React SPA — twins of the HTML/HTMX
 * handlers in routes/checkout.ts, reusing the SAME exported helpers
 * (checkoutView / payView / payState / performCheckout) so there is exactly
 * one implementation of checkout's business rules. The order-creating POST
 * /api/v1/checkout already exists in routes/api.ts (extended there with the
 * wallet flags); the three payment webhooks stay in routes/checkout.ts
 * untouched.
 *
 * Auth: cookie session, JSON-shaped (401 body, not the HTML routes' 303
 * redirect). Guest checkout (Task 4) splits these routes in two:
 *   - the two read-only checkout routes (summary + voucher preview) serve
 *     anonymous visitors, whose cart comes from the `shop_cart_v2` cookie;
 *     CSRF is delegated to `csrfOk` (./cart), the one repo-wide rule.
 *   - the three order routes (pay / status / cancel) stay session-locked with
 *     an ownership check, deliberately: a guest buyer holds a real session
 *     from the moment their order is created (routes/api.ts mints one), so
 *     they reach these through exactly the same door as a registered buyer
 *     and nothing here needs loosening.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "@app/core/errors";
import { prisma, getOrderByCode, cancelOrder } from "@app/db";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { checkoutView, payView, payState } from "./checkout";
import { csrfOk } from "./cart";

/** JSON-flavored auth gate: 401 body instead of the HTML routes' 303. */
async function requireCustomer(req: FastifyRequest, reply: FastifyReply): Promise<Customer | null> {
  const customer = await optionalCustomer(req);
  if (!customer) {
    void reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return customer;
}

const apiCheckoutRoutes: FastifyPluginAsync = async (app) => {
  // ---- Checkout summary + method availability ----
  // Guest checkout (Task 4): anonymous visitors get the summary too, priced
  // from their cart cookie, with `is_guest: true` telling the SPA to collect
  // a contact email. The order-creating POST (routes/api.ts) is where a guest
  // is actually validated and given a session.
  app.get("/checkout", async (req, reply) => {
    const customer = await optionalCustomer(req);
    return reply.send(await checkoutView(req, customer, null, null));
  });

  // ---- Voucher preview: recompute totals WITHOUT creating an order ----
  // Also open to guests. CSRF is `csrfOk` from ./cart — the single repo-wide
  // rule (guests are covered by the cart cookie's SameSite=Lax, signed-in
  // callers must present the session token), so there is exactly one place
  // that decides it rather than a second copy living here.
  app.post<{ Body: { voucher_code?: string } }>("/checkout/voucher/preview", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!csrfOk(req, customer)) {
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
    if (!csrfOk(req, customer)) {
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
