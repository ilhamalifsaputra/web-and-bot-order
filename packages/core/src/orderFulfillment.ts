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

/** What the buyer's single Telegram progress message shows. */
export type CustomerProgressPhase =
  | "NONE" | "PAYMENT_DETECTED"
  | "AUTO_QUEUED" | "AUTO_SUBMITTING" | "AUTO_PROCESSING" | "PREPARING"
  | "MANUAL_ENQUEUING" | "MANUAL_WAITING"
  | "SUCCESS" | "FAILED" | "REVIEW" | "CANCELLED";
export interface CustomerProgress {
  phase: CustomerProgressPhase;
  /** Whether the line animates; static phases are never re-edited for a frame. */
  spinner: boolean;
  /** Provider top-up wording (Digiflazz) instead of generic product wording. */
  topUp: boolean;
}

/** Payment observed (on-chain deposit, attached proof) but not final yet. */
const PAYMENT_SEEN = ["PAYMENT_DETECTED", "CONFIRMING", "CONFIRMED", "PENDING_VERIFICATION", "UNDERPAID"];

/**
 * Pure projection of durable order state onto the buyer's progress message.
 * The order status decides first, so a payment that is only detected is never
 * rendered as paid even when `paidAt` is already stamped. `messageSent` is the
 * persisted message id's presence: a manual order shows its queue spinner on
 * the first send only, then settles on a static waiting line.
 */
export function customerProgressPhase(order: FulfillmentOrder, opts: { messageSent?: boolean } = {}): CustomerProgress {
  const provider = fulfillmentProviderFor(order);
  const topUp = provider === "DIGIFLAZZ";
  const status = order.status.toUpperCase();
  const of = (phase: CustomerProgressPhase, spinner: boolean): CustomerProgress => ({ phase, spinner, topUp });
  if (status === "DELIVERED") return of("SUCCESS", false);
  if (["CANCELLED", "EXPIRED", "REFUNDED", "CREDITED_TO_BALANCE"].includes(status)) return of("CANCELLED", false);
  if (["FAILED", "REJECTED"].includes(status)) return of("FAILED", false);
  if (status === "PARTIALLY_DELIVERED") return of("REVIEW", false);
  if (PAYMENT_SEEN.includes(status)) return of("PAYMENT_DETECTED", true);
  if (status !== "PROCESSING" && status !== "PAID") return of("NONE", false);
  if (provider === "MANUAL") return opts.messageSent ? of("MANUAL_WAITING", false) : of("MANUAL_ENQUEUING", true);
  if (provider === "STOCK") return of("PREPARING", true);
  const fulfillment = getOrderFulfillment(order).status;
  if (fulfillment === "NEEDS_REVIEW") return of("REVIEW", false);
  return of(fulfillment === "SUBMITTING" ? "AUTO_SUBMITTING" : fulfillment === "PROCESSING" ? "AUTO_PROCESSING" : "AUTO_QUEUED", true);
}
