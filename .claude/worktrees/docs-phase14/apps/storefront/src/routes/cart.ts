/**
 * Cart — works for guests AND signed-in customers (plan.md §5 decision D):
 *   - guests: lines live in the httpOnly `shop_cart` cookie ({p, q}[]);
 *     SameSite=Lax means cross-site POSTs never carry the cookie, which is the
 *     CSRF story for the (money-free) guest cart.
 *   - signed in: lines are CartItem rows via the same crud the bot uses, and
 *     every mutation requires the session CSRF token.
 * The guest cookie is merged into CartItem at login (routes/auth.ts).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Decimal } from "@app/core/money";
import { UserRole } from "@app/core/enums";
import {
  prisma,
  getCartWithDenominationProduct,
  addToCart,
  updateCartItemQty,
  removeFromCart,
  getDenomination,
  getDenominationWithProduct,
  countAvailableStock,
} from "@app/db";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { productImage } from "../images";
import { shopContext, readGuestCart, writeGuestCart, type GuestCartLine } from "../shop";

/** Cart-line label per the 3-tier spec: `Product - Denomination`. */
function cartLineLabel(productName: string, denominationName: string): string {
  return productName === denominationName ? productName : `${productName} - ${denominationName}`;
}

const clampQty = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.max(0, Math.min(n, 99)) : 0;
};

/** CSRF gate for signed-in mutations (guests are covered by SameSite=Lax). */
function csrfOk(req: FastifyRequest, customer: Customer | null): boolean {
  if (!customer) return true;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = body.csrf_token ?? req.headers["x-csrf-token"];
  return Boolean(token) && token === customer.csrf;
}

export interface CartLineView {
  key: number; // cartItemId (signed in) or denomination id (guest)
  /** Denomination id — the sellable SKU (cart cookie `p`). */
  denomination_id: number;
  /** Parent product slug, for the line's link to product detail (/p/:slug). */
  product_slug: string;
  /** Display label: `Product - Denomination` (e.g. "CapCut Pro - 1 Month"). */
  name: string;
  image: string;
  unit_price: string;
  qty: number;
  line_total: string;
  available: number;
}

/** Shared shape for the cart page + checkout summary. */
export async function loadCartLines(
  req: FastifyRequest,
  customer: Customer | null,
): Promise<CartLineView[]> {
  if (customer) {
    const isReseller = customer.user.role === UserRole.RESELLER;
    // Join the parent Product so the line can show `Product - Denomination`.
    const rows = await getCartWithDenominationProduct(prisma, customer.userId);
    return Promise.all(
      rows
        .filter((r) => r.product.isActive)
        .map(async (r) => {
          const denom = r.product; // the Denomination (SKU)
          const parent = denom.product; // the mid-tier Product
          const unit = new Decimal(
            isReseller && denom.resellerPrice != null ? denom.resellerPrice : denom.price,
          );
          return {
            key: r.id,
            denomination_id: r.productId,
            product_slug: parent.slug,
            name: cartLineLabel(parent.name, denom.name),
            image: denom.webImageUrl ?? productImage(parent, parent.category.name),
            unit_price: unit.toString(),
            qty: r.quantity,
            line_total: unit.times(r.quantity).toString(),
            available: await countAvailableStock(prisma, r.productId),
          };
        }),
    );
  }
  const lines = readGuestCart(req);
  const resolved = await Promise.all(
    lines.map(async (l) => {
      const [denom, available] = await Promise.all([
        getDenominationWithProduct(prisma, l.p),
        countAvailableStock(prisma, l.p),
      ]);
      if (!denom || !denom.isActive) return null;
      const parent = denom.product; // mid-tier Product (+ category)
      const unit = new Decimal(denom.price);
      return {
        key: l.p,
        denomination_id: l.p,
        product_slug: parent.slug,
        name: cartLineLabel(parent.name, denom.name),
        image: denom.webImageUrl ?? productImage(parent, parent.category.name),
        unit_price: unit.toString(),
        qty: l.q,
        line_total: unit.times(l.q).toString(),
        available,
      } satisfies CartLineView;
    }),
  );
  return resolved.filter((l): l is CartLineView => l !== null);
}

const cartRoutes: FastifyPluginAsync = async (app) => {
  app.get("/cart", async (req, reply) => {
    const customer = await optionalCustomer(req);
    req.customer = customer;
    const ctx = await shopContext(req, "/cart");
    const items = await loadCartLines(req, customer);
    const subtotal = items.reduce((s, l) => s.plus(l.line_total), new Decimal(0));
    return reply.view("cart.njk", {
      ...ctx,
      items,
      subtotal: subtotal.toString(),
    });
  });

  app.post<{ Body: { denomination_id?: string; qty?: string; csrf_token?: string; buy_now?: string } }>(
    "/cart/add",
    async (req, reply) => {
      const customer = await optionalCustomer(req);
      if (!csrfOk(req, customer)) {
        return reply.code(403).type("text/plain").send("CSRF check failed");
      }
      const denominationId = Number(req.body.denomination_id);
      const qty = clampQty(req.body.qty ?? 1) || 1;
      const denom = Number.isInteger(denominationId)
        ? await getDenomination(prisma, denominationId)
        : null;
      if (denom?.isActive) {
        if (customer) {
          await addToCart(prisma, customer.userId, denom.id, qty);
        } else {
          const lines = readGuestCart(req);
          const existing = lines.find((l) => l.p === denom.id);
          const next: GuestCartLine[] = existing
            ? lines.map((l) => (l.p === denom.id ? { p: l.p, q: Math.min(l.q + qty, 99) } : l))
            : [...lines, { p: denom.id, q: qty }];
          writeGuestCart(reply, next);
        }
      }
      // "Buy Now" sends the buyer straight to checkout (login-gated there);
      // "Add To Cart" lands on the cart page.
      const dest = req.body.buy_now ? "/checkout" : "/cart";
      return reply.code(303).redirect(dest);
    },
  );

  app.post<{ Body: { key?: string; qty?: string; csrf_token?: string } }>(
    "/cart/update",
    async (req, reply) => {
      const customer = await optionalCustomer(req);
      if (!csrfOk(req, customer)) {
        return reply.code(403).type("text/plain").send("CSRF check failed");
      }
      const key = Number(req.body.key);
      const qty = clampQty(req.body.qty);
      if (Number.isInteger(key)) {
        if (customer) {
          await updateCartItemQty(prisma, customer.userId, key, qty);
        } else {
          const lines = readGuestCart(req);
          const next = qty <= 0
            ? lines.filter((l) => l.p !== key)
            : lines.map((l) => (l.p === key ? { p: l.p, q: qty } : l));
          writeGuestCart(reply, next);
        }
      }
      return reply.code(303).redirect("/cart");
    },
  );

  app.post<{ Body: { key?: string; csrf_token?: string } }>("/cart/remove", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!csrfOk(req, customer)) {
      return reply.code(403).type("text/plain").send("CSRF check failed");
    }
    const key = Number(req.body.key);
    if (Number.isInteger(key)) {
      if (customer) {
        await removeFromCart(prisma, customer.userId, key);
      } else {
        writeGuestCart(reply, readGuestCart(req).filter((l) => l.p !== key));
      }
    }
    return reply.code(303).redirect("/cart");
  });
};

export default cartRoutes;
