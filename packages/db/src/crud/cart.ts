/**
 * Cart domain — port of the "Cart" section of Python crud.py. Quantity is
 * capped at 99 per line.
 */
import type { Db } from "./_types";
import type { CartCompositionLine } from "@app/core/cartComposition";

/**
 * Adapt a `getCart` row to the shape the shared cart composition rule
 * (@app/core/cartComposition) reads. Used by both money-moving choke points
 * that re-assert cart composition — the gateway rail
 * (apps/storefront/src/routes/checkout.ts) and the pay-from-balance rail
 * (./wallet_checkout.ts) — so those two can no longer disagree about which
 * denomination fields the rule is applied to.
 *
 * Note `row.product` is the Denomination (the sellable SKU), not the mid-tier
 * Product; the relation kept its pre-rename name (see getCart's include).
 */
export function cartCompositionLineOfCartItem(row: {
  productId: number;
  product: { deliveryType: string; autoDeliverySource: string | null };
}): CartCompositionLine {
  return {
    denominationId: row.productId,
    deliveryType: row.product.deliveryType,
    autoDeliverySource: row.product.autoDeliverySource,
  };
}

export function getCart(db: Db, userId: number) {
  return db.cartItem.findMany({
    where: { userId },
    include: { product: { include: { product: { include: { category: true } } } } },
    orderBy: { addedAt: "asc" },
  });
}

/**
 * Cart rows with the denomination AND its parent product (+ category) joined —
 * the storefront needs the parent product name to render the cart-line label
 * `Product - Denomination ×qty`. `r.product` is the Denomination (SKU);
 * `r.product.product` is its mid-tier Product. Renamed in Phase 5 cleanup.
 */
export function getCartWithDenominationProduct(db: Db, userId: number) {
  return db.cartItem.findMany({
    where: { userId },
    include: { product: { include: { product: { include: { category: true } } } } },
    orderBy: { addedAt: "asc" },
  });
}

/** Upsert: increment quantity (capped 99) if the product is already in cart. */
export async function addToCart(
  db: Db,
  userId: number,
  productId: number,
  quantity = 1,
) {
  const existing = await db.cartItem.findUnique({
    where: { userId_productId: { userId, productId } },
  });
  if (existing) {
    return db.cartItem.update({
      where: { id: existing.id },
      data: { quantity: Math.min(existing.quantity + quantity, 99) },
    });
  }
  return db.cartItem.create({ data: { userId, productId, quantity } });
}

export async function updateCartItemQty(
  db: Db,
  userId: number,
  cartItemId: number,
  qty: number,
) {
  if (qty <= 0) {
    await removeFromCart(db, userId, cartItemId);
    return;
  }
  await db.cartItem.updateMany({
    where: { id: cartItemId, userId },
    data: { quantity: Math.min(qty, 99) },
  });
}

/** The `autoDeliverySource` of a single cart line's denomination, keyed by
 * `cartItemId` (same `key` a signed-in buyer's POST /cart/update sends) —
 * lets that route check the Digiflazz single-unit invariant BEFORE writing a
 * new quantity, without pulling the whole cart. Null if the line doesn't
 * exist (already removed, or belongs to a different user). */
export function getCartItemAutoDeliverySource(db: Db, userId: number, cartItemId: number) {
  return db.cartItem
    .findFirst({
      where: { id: cartItemId, userId },
      select: { product: { select: { autoDeliverySource: true } } },
    })
    .then((row) => row?.product.autoDeliverySource ?? null);
}

/** True when `userId` already holds a cart line for `productId` (a
 * denomination id) — lets a caller decide "merge" vs "skip" for a single
 * denomination without pulling the whole cart. Used by the guest-cart merge
 * on login (routes/auth.ts establishSession) to avoid pushing a
 * Digiflazz-routed line above its single-unit invariant via addToCart's own
 * increment-on-existing behavior. */
export async function hasCartItem(db: Db, userId: number, productId: number): Promise<boolean> {
  const existing = await db.cartItem.findUnique({ where: { userId_productId: { userId, productId } } });
  return existing !== null;
}

export async function removeFromCart(db: Db, userId: number, cartItemId: number) {
  await db.cartItem.deleteMany({ where: { id: cartItemId, userId } });
}

export async function clearCart(db: Db, userId: number) {
  await db.cartItem.deleteMany({ where: { userId } });
}
