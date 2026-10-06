/** Buyer-safe projection of durable order/payment/provider state. No timers or I/O. */
export type FulfillmentProvider = "DIGIFLAZZ" | "MANUAL" | "STOCK";
export type FulfillmentStatus = "NOT_STARTED" | "QUEUED" | "SUBMITTING" | "PROCESSING" | "SUCCESS" | "FAILED" | "NEEDS_REVIEW" | "CANCELLED";
export interface FulfillmentOrder {
  status: string;
  paidAt?: Date | null;
  fulfillmentProvider?: string | null;
  digiflazzDispatchedAt?: Date | null;
  digiflazzAttempts?: number;
  digiflazzStatus?: string | null;
  items: readonly { deliveryTypeSnapshot?: string | null; product: { autoDeliverySource?: string | null; deliveryType?: string } }[];
}
export interface OrderFulfillment {
  mode: "AUTO" | "MANUAL";
  provider: FulfillmentProvider;
  status: FulfillmentStatus;
  payment_status: "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED";
  can_edit_customer_data: boolean;
}

export function fulfillmentProviderFor(order: Pick<FulfillmentOrder, "fulfillmentProvider" | "items">): FulfillmentProvider {
  if (order.fulfillmentProvider === "DIGIFLAZZ" || order.fulfillmentProvider === "MANUAL" || order.fulfillmentProvider === "STOCK") return order.fulfillmentProvider;
  if (order.items.some(i => i.product.autoDeliverySource === "digiflazz")) return "DIGIFLAZZ";
  return order.items.some(i => (i.deliveryTypeSnapshot ?? i.product.deliveryType) !== "auto") ? "MANUAL" : "STOCK";
}

export function toBuyerDigiflazzStatus(internal: string | null): "pending" | "reviewing" | null {
  return internal === "pending_at_supplier" ? "pending" : internal === "failed" ? "reviewing" : null;
}

export function getOrderFulfillment(order: FulfillmentOrder): OrderFulfillment {
  const provider = fulfillmentProviderFor(order);
  const orderStatus = order.status.toUpperCase();
  const paid = !!order.paidAt || orderStatus === "DELIVERED" || orderStatus === "PROCESSING";
  const payment_status = ["REFUNDED", "CREDITED_TO_BALANCE"].includes(orderStatus) ? "REFUNDED" : paid ? "PAID" : orderStatus === "EXPIRED" ? "EXPIRED" : ["FAILED", "REJECTED"].includes(orderStatus) ? "FAILED" : "PENDING";
  let status: FulfillmentStatus = "NOT_STARTED";
  if (orderStatus === "DELIVERED") status = "SUCCESS";
  else if (["CANCELLED", "EXPIRED", "REFUNDED", "CREDITED_TO_BALANCE"].includes(orderStatus)) status = "CANCELLED";
  else if (["FAILED", "REJECTED"].includes(orderStatus)) status = "FAILED";
  else if (orderStatus === "PROCESSING") {
    if (provider === "DIGIFLAZZ") {
      status = order.digiflazzStatus === "failed" ? "NEEDS_REVIEW" : !order.digiflazzDispatchedAt ? "QUEUED" : (order.digiflazzAttempts ?? 0) === 0 ? "SUBMITTING" : "PROCESSING";
    } else status = "QUEUED";
  }
  return {
    mode: provider === "MANUAL" ? "MANUAL" : "AUTO", provider, status, payment_status,
    can_edit_customer_data: orderStatus === "PROCESSING" && (provider !== "DIGIFLAZZ" || (!order.digiflazzDispatchedAt && status !== "NEEDS_REVIEW")),
  };
}
