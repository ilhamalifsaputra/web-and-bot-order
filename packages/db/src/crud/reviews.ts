/**
 * Reviews + restock subscriptions — port of those sections of crud.py.
 */
import { OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

export async function createReview(
  db: Db,
  args: {
    userId: number;
    orderId: number;
    productId: number;
    rating: number;
    comment: string | null;
  },
) {
  const order = await db.order.findUnique({ where: { id: args.orderId } });
  if (!order || order.userId !== args.userId) {
    throw new ValidationError("error.order_not_found");
  }
  if (order.status !== OrderStatus.DELIVERED) {
    throw new ValidationError("error.review_requires_delivered");
  }
  try {
    return await db.review.create({
      data: {
        userId: args.userId,
        orderId: args.orderId,
        productId: args.productId,
        rating: args.rating,
        comment: args.comment,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ValidationError("error.review_already_exists");
    }
    throw e;
  }
}

/** Returns true if newly subscribed, false if already subscribed. */
export async function subscribeToRestock(
  db: Db,
  userId: number,
  productId: number,
): Promise<boolean> {
  try {
    await db.restockSubscription.create({ data: { userId, productId } });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

export function listRestockSubscribers(db: Db, productId: number) {
  return db.restockSubscription.findMany({
    where: { productId },
    include: { product: true },
  });
}
