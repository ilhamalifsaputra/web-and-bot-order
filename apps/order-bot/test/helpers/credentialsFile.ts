import { prisma, markCredentialsDelivered } from "@app/db";
import { OrderKind, OrderStatus } from "@app/core/enums";

/**
 * Stand in for the outbox dispatcher acknowledging a delivered product order's
 * credentials `.txt` (what `deliverAccountDm` records after `sendDocument`).
 * A gateway rail only enqueues that DM, and the buyer's status message says
 * "completed" for a stock order only once the file was acknowledged, so tests
 * about the completed status call this before the worker's tick. It is a no-op
 * for any order that is not a delivered product sale.
 */
export async function acknowledgeCredentialsFile(orderId: number, documentMessageId = 9_001): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, kind: true } });
  if (order?.status !== OrderStatus.DELIVERED || order.kind !== OrderKind.PRODUCT) return;
  await markCredentialsDelivered(prisma, orderId, documentMessageId);
}
