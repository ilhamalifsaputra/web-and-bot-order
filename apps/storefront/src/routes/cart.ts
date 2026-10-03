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
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { canonicalProduct, type CanonicalProduct } from "@app/core/canonicalProduct";
import { effectiveUnitPrice, flashPrice, activeFlashPercent } from "@app/core/flash";
import { CategoryGroup, UserRole } from "@app/core/enums";
import type { CartCompositionLine } from "@app/core/cartComposition";
import {
  prisma,
  getCartWithDenominationProduct,
  getDenominationWithProduct,
  countAvailableStock,
  activeServiceGroups,
  getCanonicalRateContext,
} from "@app/db";
import type { Customer } from "../plugins/auth";
import { productImage } from "../images";
import { readGuestCart, requestLang, requestCurrency, resolveDisplayCurrency } from "../shop";
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
  return typeof token === "string" && constantTimeEqual(token, customer.csrf) && originOk(req);
}

/** Origin/Referer check — defense-in-depth ALONGSIDE csrfOk's token check,
 * not a replacement. Compares the Origin header's hostname (or Referer's,
 * when Origin is absent) against the app's own configured public origin
 * (`SHOP_PUBLIC_URL`, falling back to `PUBLIC_URL`) when one is set, exactly
 * like `publicBase(req)` (../shop.ts) already falls back for building links.
 * Only when NEITHER is configured does this fall back to this request's own
 * hostname (Fastify's req.hostname, which already respects TRUST_PROXY the
 * same way req.ip does — see rateLimit.ts's clientIp). Preferring the
 * configured origin avoids a deploy-time availability trap: a reverse proxy
 * that doesn't forward the `Host` header correctly would otherwise make
 * req.hostname disagree with the real public origin and 403 every mutation.
 * No Origin AND no Referer passes (many legitimate same-site requests omit
 * both); a header that IS present but names a different host fails. */
export function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const raw = typeof origin === "string" ? origin : typeof referer === "string" ? referer : null;
  if (raw === null) return true;
  const configuredBase = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL;
  const expectedHostname = configuredBase ? new URL(configuredBase).hostname : req.hostname;
  try {
    return new URL(raw).hostname === expectedHostname;
  } catch {
    return false; // an unparseable Origin/Referer is suspicious, not trusted
  }
}

/** Cross-site guard for the PRE-session routes that mint a session (order-code
 * recovery, password login, registration) — backend audit Task C1. These
 * carry no CSRF token (there is no session yet to bind one to), so without
 * this a page on another site could silently log a visitor into a session of
 * the attacker's choosing (login CSRF). Refuses a browser-declared
 * `Sec-Fetch-Site: cross-site` and anything `originOk` refuses; a request
 * carrying neither header (curl, server-to-server, older browsers) still
 * passes, same as `originOk`. `same-site` is allowed: the storefront and its
 * admin/API hosts can legitimately share a registrable domain. */
export function sessionMintOriginOk(req: FastifyRequest): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  return originOk(req);
}

export interface CartLineView {
  canonical?: CanonicalProduct;
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
  /** `Denomination.autoDeliverySource` — "digiflazz" for a supplier-routed
   * game top-up, null otherwise. The cart_kind half of the composition guard
   * (POST /cart) needs it, because deliveryType alone cannot tell a top-up
   * apart from a premium SKU that collects buyer info: the Digiflazz catalog
   * sync creates both as `manual_with_info`. See @app/core/cartComposition. */
  auto_delivery_source: string | null;
  /** Live flash sale on this SKU, or null. `unit_price` above ALREADY carries
   * the discount; this is only what the line needs to strike through the old
   * price and count down to the end of the sale. */
  flash: FlashLineView | null;
}

/**
 * Adapt a rendered cart line to the shape the shared composition rule
 * (@app/core/cartComposition) reads. One mapper rather than an inline object
 * literal at each call site, so a future field the rule needs is added in one
 * place — and so the rule keeps knowing nothing about the storefront's
 * snake_case view types.
 */
export function cartCompositionLineOf(line: CartLineView): CartCompositionLine {
  return {
    denominationId: line.denomination_id,
    deliveryType: line.delivery_type,
    autoDeliverySource: line.auto_delivery_source,
  };
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
  const groups = await activeServiceGroups(prisma, "web");
  const resolved = await Promise.all(
    lines.map(async (l) => {
      const denom = await getDenominationWithProduct(prisma, l.p);
      if (!denom || !denom.isActive || !groups.has(denom.product.category.group ?? CategoryGroup.PREMIUM_APPS)) return null;
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
  const groups = await activeServiceGroups(prisma, "web");
  const display = { ...await getCanonicalRateContext(prisma), preferredCurrency: resolveDisplayCurrency(customer?.user, requestCurrency(req)) ?? "IDR", locale: requestLang(req), generatedAt: new Date().toISOString() };
  const canonicalOf = (denom: GuestCartItem["product"], unit: Decimal, available: number) => canonicalProduct({ denomination: { ...denom, createdAt: denom.createdAt.toISOString() }, product: denom.product, category: denom.product.category, stockAvailable: denom.deliveryType !== "auto" || available > 0 }, { ...display, effectivePriceIDR: unit.toString() });
  if (customer) {
    const isReseller = customer.user.role === UserRole.RESELLER;
    // Join the parent Product so the line can show `Product - Denomination`.
    const rows = await getCartWithDenominationProduct(prisma, customer.userId);
    const visibleRows = [];
    for (const row of rows) {
      if (row.product.isActive && groups.has(row.product.product.category.group ?? CategoryGroup.PREMIUM_APPS)) {
        visibleRows.push(row);
      }
    }
    return Promise.all(
      visibleRows
        .map(async (r) => {
          const denom = r.product; // the Denomination (SKU)
          const parent = denom.product; // the mid-tier Product
          const unit = effectiveUnitPrice(denom, isReseller);
          const available = await countAvailableStock(prisma, r.productId);
          return {
            canonical: canonicalOf(denom, unit, available),
            key: r.id,
            denomination_id: r.productId,
            product_slug: parent.slug,
            name: cartLineLabel(parent.name, denom.name),
            // No stock-photo fallback here either (Fase 12). CartLineView.image
            // stays `string` (never null) for contract stability; when neither
            // the denomination nor its parent product has a real photo it
            // coalesces to "", which is falsy — CartPage.tsx renders a Package
            // fallback icon for that line (mirrors SearchOverlay's ResultThumb),
            // never an <img> with an empty src (guarded since commit 8143a7ce).
            image: denom.webImageUrl ?? productImage(parent) ?? "",
            unit_price: unit.toString(),
            qty: r.quantity,
            line_total: unit.times(r.quantity).toString(),
            available,
            delivery_type: denom.deliveryType,
            auto_delivery_source: denom.autoDeliverySource,
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
      if (!denom || !denom.isActive || !groups.has(denom.product.category.group ?? CategoryGroup.PREMIUM_APPS)) return null;
      const parent = denom.product; // mid-tier Product (+ category)
      // Guests are never resellers, so the everyone price is the right one.
      const unit = effectiveUnitPrice(denom, false);
      return {
        canonical: canonicalOf(denom, unit, available),
        key: l.p,
        denomination_id: l.p,
        product_slug: parent.slug,
        name: cartLineLabel(parent.name, denom.name),
        // No stock-photo fallback here either (Fase 12) — CartLineView.image
        // stays a non-nullable string for CartPage.tsx's unconditional <img>
        // (out of scope for this task's DefaultThumb work), so an absent
        // real photo on both the denomination and its parent product renders
        // an empty src rather than a hotlinked placeholder.
        image: denom.webImageUrl ?? productImage(parent) ?? "",
        unit_price: unit.toString(),
        qty: l.q,
        line_total: unit.times(l.q).toString(),
        available,
        delivery_type: denom.deliveryType,
        auto_delivery_source: denom.autoDeliverySource,
        flash: flashViewFor(denom, unit),
      } satisfies CartLineView;
    }),
  );
  return resolved.filter((l): l is NonNullable<typeof l> => l !== null);
}
