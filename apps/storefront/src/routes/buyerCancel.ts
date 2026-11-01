import { OrderStatus, StockActorType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { prisma, cancelOrder, getOrderRaw } from "@app/db";

/**
 * A buyer's cancel, for the order and wallet top-up routes alike: attempt it,
 * then answer from the database whether the record is cancelled now.
 *
 * "Nothing threw" is not that answer. A refusal (a payment landed between the
 * last poll and the tap) is a ValidationError, and cancelOrder also returns
 * quietly for a record that already ended some other way, such as an expired
 * one. A record cancelled earlier counts: the buyer's goal holds. Any other
 * error propagates.
 */
export async function cancelAsBuyer(orderId: number, customerId: number): Promise<boolean> {
  try {
    await prisma.$transaction((tx) =>
      cancelOrder(tx, orderId, "user_cancelled", { type: StockActorType.CUSTOMER, customerId }),
    );
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
  }
  const after = await getOrderRaw(prisma, orderId);
  return after?.status === OrderStatus.CANCELLED;
}
