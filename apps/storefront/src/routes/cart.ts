/**
 * Cart — shared view/guard logic for the JSON cart endpoints (routes/api.ts's
 * POST /cart, routes/apiCart.ts's GET/update/remove). The cart PAGE itself
 * cut over to the React SPA at the Cluster A cutover (routes/spaShell.ts);
 * this file no longer registers any routes, but its exports are the single
 * source of truth for both guest carts AND signed-in customers
 * (plan.md §5 decision D):
 *   - guests: lines live in the httpOnly `shop_cart_v2` cookie ({p, q}[]);
 *     SameSite=Lax means cross-site POSTs never carry the cookie, which is the
 *     CSRF story for the (money-free) guest cart.
 *   - signed in: lines are CartItem rows via the same crud the bot uses, and
 *     every mutation requires the session CSRF token.
 * The guest cookie is merged into CartItem at login (routes/auth.ts).
 */
import type { FastifyRequest } from "fastify";
import { Decimal } from "@app/core/money";
import { effectiveUnitPrice, flashPrice, activeFlashPercent } from "@app/core/flash";
import { UserRole } from "@app/core/enums";
import {
  prisma,
  getCartWithDenominationProduct,
  getDenominationWithProduct,
  countAvailableStock,
} from "@app/db";
import type { Customer } from "../plugins/auth";
import { productImage } from "../images";
import { readGuestCart } from "../shop";
import { constantTimeEqual } from "../auth";

/** Cart-line label per the 3-tier spec: `Product - Denomination`. */
function cartLineLabel(productName: string, denominationName: string): string {
  return productName === denominationName ? productName : `${productName} - ${denominationName}`;
}

export const clampQty = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.max(0, Math.min(n, 99)) : 0;
};

/** CSRF gate for signed-in mutations (guests are covered by SameSite=Lax).
 * Shared with the JSON cart endpoints (routes/apiCart.ts) — one rule, two
 * transports (form field or x-csrf-token header). */
export function csrfOk(req: FastifyRequest, customer: Customer | null): boolean {
  if (!customer) return true;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = body.csrf_token ?? req.headers["x-csrf-token"];
  return typeof token === "string" && constantTimeEqual(token, customer.csrf);
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
  /** "auto" | "manual" | "manual_with_info" (DeliveryType) — drives the
   * single-SKU-per-non-auto-cart guard (POST /cart) and the checkout
   * info-collection step (checkoutView's items array). */
  delivery_type: string;
  /** Live flash sale on this SKU, or null. `unit_price` above ALREADY carries
   * the discount; this is only what the line needs to strike through the old
   * price and count down to the end of the sale. */
  flash: FlashLineView | null;
}

/** Flash-sale badge data shared by the cart line and the checkout summary. */
export interface FlashLineView {
  discount_percent: string;
  /** The pre-sale price, for the strike-through. */
  base_price: string;
  ends_at: string;
}

/**
 * Flash-badge payload for a denomination, or null when no sale is live. The
 * struck-through price is the everyone price (`flashPrice`'s input), never the
 * reseller's — a reseller keeping their cheaper standing price sees no badge,
 * because for them nothing was discounted.
 */
export function flashViewFor(
  denom: Parameters<typeof activeFlashPercent>[0] & { price: Decimal.Value; resellerPrice: Decimal.Value | null },
  unit: Decimal,
): FlashLineView | null {
  const percent = activeFlashPercent(denom);
  const sale = flashPrice(denom);
  if (percent === null || sale === null || !unit.equals(sale)) return null;
  return {
    discount_percent: percent.toString(),
    base_price: new Decimal(denom.price).toString(),
    ends_at: denom.flashEndsAt!.toISOString(),
  };
}

/**
 * Guest cookie cart shaped like the CartItem rows `getCart` returns, so the
 * checkout totals math (computeTotals/checkoutView, routes/checkout.ts) has
 * ONE implementation for guests and signed-in buyers alike — unlike
 * loadCartLines below, this returns the raw joined Denomination row rather
 * than the pre-formatted CartLineView the cart page renders. Order follows
 * the cookie's own order (Promise.all preserves input order), so the
 * checkout summary lists guest lines deterministically.
 */
export type GuestCartItem = {
  productId: number;
  quantity: number;
  product: NonNullable<Awaited<ReturnType<typeof getDenominationWithProduct>>>;
};

export async function loadGuestCartItems(req: FastifyRequest): Promise<GuestCartItem[]> {
  const lines = readGuestCart(req);
  const resolved = await Promise.all(
    lines.map(async (l) => {
      const denom = await getDenominationWithProduct(prisma, l.p);
      if (!denom || !denom.isActive) return null;
      return { productId: l.p, quantity: l.q, product: denom } satisfies GuestCartItem;
    }),
  );
  return resolved.filter((l): l is GuestCartItem => l !== null);
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
          const unit = effectiveUnitPrice(denom, isReseller);
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
            delivery_type: denom.deliveryType,
            flash: flashViewFor(denom, unit),
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
      // Guests are never resellers, so the everyone price is the right one.
      const unit = effectiveUnitPrice(denom, false);
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
        delivery_type: denom.deliveryType,
        flash: flashViewFor(denom, unit),
      } satisfies CartLineView;
    }),
  );
  return resolved.filter((l): l is CartLineView => l !== null);
}
