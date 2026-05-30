/**
 * Cart domain — port of the "Cart" section of Python crud.py. Quantity is
 * capped at 99 per line.
 */
import type { Db } from "./_types";

export function getCart(db: Db, userId: number) {
  return db.cartItem.findMany({
    where: { userId },
    include: { product: true },
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

export async function removeFromCart(db: Db, userId: number, cartItemId: number) {
  await db.cartItem.deleteMany({ where: { id: cartItemId, userId } });
}

export async function clearCart(db: Db, userId: number) {
  await db.cartItem.deleteMany({ where: { userId } });
}
