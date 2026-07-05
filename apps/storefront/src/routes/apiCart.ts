/**
 * JSON cart endpoints for the React SPA — update a line's quantity, remove a
 * line, and a GET for the cart page. The "add" operation already exists as
 * POST /api/v1/cart (routes/api.ts) and stays there untouched.
 *
 * CSRF story (shared csrfOk() from ./cart): guests are exempt (SameSite=Lax
 * cookie is the guard for the money-free guest cart), signed-in mutations
 * need the x-csrf-token header.
 */
import type { FastifyPluginAsync } from "fastify";
import { Decimal } from "@app/core/money";
import { prisma, updateCartItemQty, removeFromCart } from "@app/db";
import { optionalCustomer } from "../plugins/auth";
import { readGuestCart, writeGuestCart, CART_COOKIE, CART_COOKIE_VERSION, type GuestCartLine } from "../shop";
import { loadCartLines, csrfOk, clampQty } from "./cart";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Customer } from "../plugins/auth";

/** Write the guest cookie AND patch req.cookies so loadCartLines() (which
 * re-reads the request cookie) sees the value we just set on the reply —
 * same trick as routes/api.ts POST /cart. */
function writeGuestCartAndPatch(req: FastifyRequest, reply: FastifyReply, next: GuestCartLine[]): void {
  writeGuestCart(reply, next);
  req.cookies[CART_COOKIE] = JSON.stringify({ v: CART_COOKIE_VERSION, items: next });
}

async function cartPayload(req: FastifyRequest, customer: Customer | null) {
  const items = await loadCartLines(req, customer);
  const subtotal = items.reduce((s, l) => s.plus(l.line_total), new Decimal(0));
  return { items, subtotal: subtotal.toString() };
}

const apiCartRoutes: FastifyPluginAsync = async (app) => {
  // ---- Cart page data (guests OK) ----
  app.get("/cart", async (req, reply) => {
    const customer = await optionalCustomer(req);
    return reply.send(await cartPayload(req, customer));
  });

  // ---- Update a line's quantity (qty 0 removes) ----
  app.post<{ Body: { key?: number; qty?: number } }>("/cart/update", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!csrfOk(req, customer)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }
    const key = Number(req.body?.key);
    const qty = clampQty(req.body?.qty);
    if (Number.isInteger(key)) {
      if (customer) {
        await updateCartItemQty(prisma, customer.userId, key, qty);
      } else {
        const lines = readGuestCart(req);
        const next = qty <= 0
          ? lines.filter((l) => l.p !== key)
          : lines.map((l) => (l.p === key ? { p: l.p, q: qty } : l));
        writeGuestCartAndPatch(req, reply, next);
      }
    }
    return reply.send(await cartPayload(req, customer));
  });

  // ---- Remove a line ----
  app.post<{ Body: { key?: number } }>("/cart/remove", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!csrfOk(req, customer)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }
    const key = Number(req.body?.key);
    if (Number.isInteger(key)) {
      if (customer) {
        await removeFromCart(prisma, customer.userId, key);
      } else {
        writeGuestCartAndPatch(req, reply, readGuestCart(req).filter((l) => l.p !== key));
      }
    }
    return reply.send(await cartPayload(req, customer));
  });
};

export default apiCartRoutes;
