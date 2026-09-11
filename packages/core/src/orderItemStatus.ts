/**
 * Deriving an Order's status from its items' statuses (Trustance Phase 1,
 * Task 3) — the pure half of `recomputeOrderStatus`
 * (packages/db/src/crud/orders.ts), split out so the decision table can be
 * tested exhaustively without a database.
 *
 * Today this is a no-op in production: every order the current code paths can
 * create is homogeneous (see @app/core/cartComposition), its items are written
 * to one shared status in the same transaction as the order-level status, and
 * so the derived status always equals the status the order already has — which
 * this function reports as `null`, "nothing to change". That is the property
 * Task 3 had to prove, and packages/db/src/crud/orderItemStatus.test.ts proves
 * it end-to-end for every order shape.
 */
import { OrderStatus, OrderItemStatus, IN_FLIGHT_ORDER_ITEM_STATUSES } from "./enums";

const TERMINAL: readonly string[] = [
  OrderItemStatus.DELIVERED,
  OrderItemStatus.FAILED,
  OrderItemStatus.CANCELLED,
];

/**
 * The status an order SHOULD have given its items, or `null` when it should be
 * left exactly as it is.
 *
 * `null` — meaning "do not write" — covers five distinct situations on purpose,
 * because a caller has the same correct response to all of them:
 *
 * - the order has no items at all (a wallet top-up);
 * - some item still has an in-flight status, so no outcome is settled yet;
 * - some item's status is `null`, i.e. an `OrderItem` row written before the
 *   column existed (this repo deploys with `prisma db push`, which never
 *   backfills — see the column's comment in schema.prisma). Deriving from an
 *   unknown would be guessing, and a wrong guess rewrites a real order;
 * - some item carries a string this enum does not recognize;
 * - the derived status is the one the order already has.
 *
 * @param itemStatuses one entry per OrderItem, in any order; `null` for a row
 *   predating the column.
 * @param currentStatus the order's stored `Order.status`.
 */
export function deriveOrderStatusFromItems(
  itemStatuses: readonly (string | null)[],
  currentStatus: string,
): OrderStatus | null {
  if (itemStatuses.length === 0) return null;
  // Unknown or legacy-null anywhere in the set poisons the whole derivation —
  // a partial view of the items cannot support a whole-order conclusion.
  if (itemStatuses.some((s) => s === null)) return null;
  const statuses = itemStatuses as readonly string[];
  if (statuses.some((s) => IN_FLIGHT_ORDER_ITEM_STATUSES.includes(s as OrderItemStatus))) return null;
  if (statuses.some((s) => !TERMINAL.includes(s))) return null;

  const delivered = statuses.some((s) => s === OrderItemStatus.DELIVERED);
  const failed = statuses.some((s) => s === OrderItemStatus.FAILED);
  const cancelled = statuses.some((s) => s === OrderItemStatus.CANCELLED);

  let derived: OrderStatus | null;
  if (delivered && !failed && !cancelled) derived = OrderStatus.DELIVERED;
  else if (failed && !delivered && !cancelled) derived = OrderStatus.FAILED;
  else if (cancelled && !delivered && !failed) derived = OrderStatus.CANCELLED;
  else if (delivered) derived = OrderStatus.PARTIALLY_DELIVERED;
  // A FAILED/CANCELLED mix with nothing delivered: both are "the buyer got
  // nothing", but which one the ORDER is depends on why each line ended that
  // way, and the items alone do not say. Unreachable today; left to the plan
  // that makes it reachable rather than guessed at now.
  else derived = null;

  return derived === currentStatus ? null : derived;
}
