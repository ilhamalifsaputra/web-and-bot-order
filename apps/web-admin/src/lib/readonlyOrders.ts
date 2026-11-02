import type { getTicketWithOrder, listOrders, listPendingInternalOrders } from "@app/db";
import { displayDate, displayDateTime } from "../dateDisplay";

/**
 * What a readonly admin may see of an order outside `GET /api/orders/:orderId`,
 * which refuses that role. These are allow-lists, not deny-lists: buyer
 * checkout answers, payment proofs, staff notes, supplier diagnostics and costs
 * stay out, and so does any Order column added later. Each list holds what its
 * page renders; support and super keep the routes' full rows.
 */
type ListedOrder = Awaited<ReturnType<typeof listOrders>>[number];
type PendingInternalOrder = Awaited<ReturnType<typeof listPendingInternalOrders>>[number];
type LinkedTicketOrder = NonNullable<NonNullable<Awaited<ReturnType<typeof getTicketWithOrder>>>["order"]>;

/** A buyer's name and nothing else, for the Payments page's order panels. */
function readonlyBuyerName(user: Pick<ListedOrder["user"], "fullName" | "username">) {
  return { fullName: user.fullName, username: user.username };
}

/** One order in a customer's order history: UserDetailPage and the ticket's customer block. */
export function readonlyOrderSummary(
  order: Pick<ListedOrder, "id" | "orderCode" | "status" | "currency" | "totalAmount" | "createdAt">,
) {
  return {
    id: order.id,
    orderCode: order.orderCode,
    status: order.status,
    currency: order.currency,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
    createdAtDisplay: displayDate(order.createdAt),
  };
}

/** The summary plus what TicketIssueContext renders for a ticket's linked
 * order: item lines by name and price, and the voucher's code and type. */
export function readonlyLinkedOrder(order: LinkedTicketOrder) {
  return {
    ...readonlyOrderSummary(order),
    items: order.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      product: { id: item.product.id, name: item.product.name },
    })),
    voucher: order.voucher ? { code: order.voucher.code, type: order.voucher.type } : null,
  };
}

/** One row of the Orders page table. */
export function readonlyOrderListRow<Eligibility>(order: ListedOrder, eligibility: Eligibility) {
  return {
    id: order.id,
    orderCode: order.orderCode,
    status: order.status,
    kind: order.kind,
    currency: order.currency,
    totalAmount: order.totalAmount,
    paymentMethod: order.paymentMethod,
    createdAt: order.createdAt,
    createdAtDisplay: displayDate(order.createdAt),
    digiflazzStatus: order.digiflazzStatus,
    eligibility,
    user: {
      id: order.user.id,
      fullName: order.user.fullName,
      username: order.user.username,
      telegramId: order.user.telegramId,
      isGuest: order.user.isGuest,
      guestEmail: order.user.guestEmail,
    },
    items: order.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      product: { id: item.product.id, name: item.product.name },
    })),
  };
}

/** One row of the Payments page's Underpaid Orders panel. */
export function readonlyUnderpaidOrder(order: ListedOrder) {
  return {
    id: order.id,
    orderCode: order.orderCode,
    totalAmount: order.totalAmount,
    currency: order.currency,
    createdAt: order.createdAt,
    createdAtDisplay: displayDateTime(order.createdAt),
    kind: order.kind,
    user: readonlyBuyerName(order.user),
  };
}

/** One row of the Payments page's pending internal transfers panel. Keeps
 * `paymentRef` because that panel renders it as the Transfer Ref column. */
export function readonlyPendingInternalOrder(order: PendingInternalOrder) {
  return {
    id: order.id,
    orderCode: order.orderCode,
    totalAmount: order.totalAmount,
    currency: order.currency,
    paymentRef: order.paymentRef,
    expiresAt: order.expiresAt,
    expiresAtDisplay: displayDateTime(order.expiresAt),
    user: readonlyBuyerName(order.user),
  };
}
