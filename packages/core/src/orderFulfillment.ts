/** Buyer-safe projection of durable order/payment/provider state. No timers or I/O. */
export type FulfillmentProvider = "DIGIFLAZZ" | "MANUAL" | "STOCK";
export type FulfillmentStatus = "NOT_STARTED" | "QUEUED" | "SUBMITTING" | "PROCESSING" | "SUCCESS" | "FAILED" | "NEEDS_REVIEW" | "CANCELLED";
export interface FulfillmentOrder {
  status: string;
  kind?: string;
  paymentState?: string | null;
  walletCreditState?: string | null;
  completionMode?: string | null;
  paidAt?: Date | null;
  fulfillmentProvider?: string | null;
  digiflazzDispatchedAt?: Date | null;
  digiflazzAttempts?: number;
  digiflazzStatus?: string | null;
  items: readonly { deliveryTypeSnapshot?: string | null; product: { autoDeliverySource?: string | null; deliveryType?: string; product?: { name?: string; digiflazzBrand?: string | null; category?: { group?: string | null } } } }[];
}
export interface OrderFulfillment {
  mode: "AUTO" | "MANUAL";
  provider: FulfillmentProvider;
  status: FulfillmentStatus;
  payment_status: "PENDING" | "PAYMENT_DETECTED" | "VERIFYING" | "UNDERPAID" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED";
  presentation: CustomerProgress;
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
  const payment_status = paymentStatusFor(order);
  let status: FulfillmentStatus = "NOT_STARTED";
  if (orderStatus === "DELIVERED") status = "SUCCESS";
  else if (order.kind === "WALLET_TOPUP" && payment_status === "PAID" && order.walletCreditState === "NEEDS_REVIEW") status = "NEEDS_REVIEW";
  else if (["CANCELLED", "EXPIRED", "REFUNDED", "CREDITED_TO_BALANCE"].includes(orderStatus)) status = "CANCELLED";
  else if (["FAILED", "REJECTED"].includes(orderStatus)) status = "FAILED";
  else if (orderStatus === "PROCESSING") {
    if (provider === "DIGIFLAZZ") {
      status = order.digiflazzStatus === "failed" ? "NEEDS_REVIEW" : !order.digiflazzDispatchedAt ? "QUEUED" : (order.digiflazzAttempts ?? 0) === 0 ? "SUBMITTING" : "PROCESSING";
    } else status = "QUEUED";
  }
  return {
    mode: provider === "MANUAL" ? "MANUAL" : "AUTO", provider, status, payment_status, presentation: customerProgressPhase(order),
    can_edit_customer_data: orderStatus === "PROCESSING" && (provider !== "DIGIFLAZZ" || (!order.digiflazzDispatchedAt && status !== "NEEDS_REVIEW")),
  };
}

/** What the buyer's single Telegram progress message shows. */
export type CustomerProgressPhase =
  | "NONE" | "PAYMENT_DETECTED" | "VERIFYING" | "PAYMENT_CONFIRMED" | "UNDERPAID"
  | "AUTO_QUEUED" | "AUTO_SUBMITTING" | "AUTO_PROCESSING" | "PREPARING"
  | "MANUAL_ENQUEUING" | "MANUAL_WAITING"
  | "DELIVERING"
  | "SUCCESS" | "FAILED" | "REVIEW" | "CANCELLED" | "CREDITED" | "WALLET_CREDITING" | "WALLET_CREDITED";
export interface CustomerProgress {
  phase: CustomerProgressPhase;
  /** Whether the line animates; static phases are never re-edited for a frame. */
  spinner: boolean;
  /** Provider top-up wording (Digiflazz) instead of generic product wording. */
  topUp: boolean;
  transactionType: "GAME_TOPUP" | "PREMIUM_APPS" | "WALLET_TOPUP";
  progress: number | null;
  titleKey: string;
  bodyKey: string;
}

/** Full canonical source used by wallet history, invoices and status messages. */
export function getCustomerFacingReference(order: { orderCode: string; kind?: string; status?: string }): string {
  return order.orderCode;
}

export function paymentStatusFor(order: FulfillmentOrder): OrderFulfillment["payment_status"] {
  const status = order.status.toUpperCase();
  if (["REFUNDED", "CREDITED_TO_BALANCE"].includes(status)) return "REFUNDED";
  if (status === "UNDERPAID" || order.paymentState === "UNDERPAID") return "UNDERPAID";
  // In-flight order evidence wins over any stale timestamp or cached projection.
  if (status === "PAYMENT_DETECTED") return "PAYMENT_DETECTED";
  if (["CONFIRMING", "CONFIRMED"].includes(status)) return "VERIFYING";
  if (order.paymentState === "PAID") return "PAID";
  if (order.paymentState === "PAYMENT_DETECTED" || order.paymentState === "VERIFYING") return order.paymentState;
  if (order.paymentState === "FAILED" || order.paymentState === "EXPIRED" || order.paymentState === "REFUNDED") return order.paymentState;
  if (status === "PENDING_VERIFICATION") return "PENDING"; // attached proof awaits a human
  if (order.completionMode === "ADMIN_OVERRIDE") return "PENDING";
  if (order.paidAt || ["PAID", "DELIVERED", "PROCESSING"].includes(status)) return "PAID";
  return status === "EXPIRED" ? "EXPIRED" : ["FAILED", "REJECTED"].includes(status) ? "FAILED" : "PENDING";
}

/**
 * Percentages describe committed phases, never elapsed time. While a payment is
 * only detected or still being verified there is no honest percentage to show
 * (it may yet fail or be underpaid), so those two phases yield `null` and the
 * renderers omit the bar. The bar starts once the payment is confirmed.
 */
export function progressForPhase(phase: CustomerProgressPhase): number | null {
  switch (phase) {
    case "PAYMENT_CONFIRMED": return 40;
    case "AUTO_QUEUED": case "PREPARING": return 55;
    case "AUTO_SUBMITTING": return 65;
    case "AUTO_PROCESSING": case "WALLET_CREDITING": return 80;
    case "DELIVERING": return 90;
    case "SUCCESS": case "WALLET_CREDITED": return 100;
    default: return null;
  }
}

/**
 * Pure projection of durable order state onto the buyer's progress message.
 * The order status decides first, so a payment that is only detected is never
 * rendered as paid even when `paidAt` is already stamped. Manual queues and
 * submitted payment proofs remain static from their first render. `credited` says
 * the paid amount went to the buyer's wallet balance (an `unfulfilled_credit`
 * ledger row), which `creditOrderToBalance` records on a CANCELLED order.
 * `credentialsDelivered` says Telegram acknowledged the stock order's
 * credentials file (`Order.credentialsDeliveredAt`). Only the Telegram status
 * worker passes it: a delivered STOCK order it reports as not yet acknowledged
 * shows DELIVERING ("sending your account details") instead of SUCCESS. Callers
 * that leave it out (the storefront, which shows the account on the order page
 * itself) keep SUCCESS.
 */
export function customerProgressPhase(order: FulfillmentOrder, opts: { messageSent?: boolean; credited?: boolean; credentialsDelivered?: boolean } = {}): CustomerProgress {
  const provider = fulfillmentProviderFor(order);
  const group = order.items.map(i => i.product.product?.category?.group).find(Boolean);
  const transactionType = order.kind === "WALLET_TOPUP" ? "WALLET_TOPUP" : group === "GAME_TOPUP" || (!group && provider === "DIGIFLAZZ") ? "GAME_TOPUP" : "PREMIUM_APPS";
  const topUp = transactionType === "GAME_TOPUP";
  const status = order.status.toUpperCase();
  const prefix = transactionType === "WALLET_TOPUP" ? "wallet" : topUp ? "game" : "premium";
  const copy: Record<CustomerProgressPhase, string> = {
    NONE: "waiting", PAYMENT_DETECTED: "payment_detected", VERIFYING: "verifying", PAYMENT_CONFIRMED: `${prefix}_confirmed`,
    UNDERPAID: "underpaid", AUTO_QUEUED: `${prefix}_queued`, AUTO_SUBMITTING: `${prefix}_submitting`, AUTO_PROCESSING: `${prefix}_processing`,
    PREPARING: `${prefix}_queued`, MANUAL_ENQUEUING: "manual_waiting", MANUAL_WAITING: "manual_waiting", DELIVERING: "premium_delivering", SUCCESS: `${prefix}_success`,
    FAILED: `${prefix}_failed`, REVIEW: `${prefix}_review`, CANCELLED: "cancelled", CREDITED: "credited",
    WALLET_CREDITING: "wallet_crediting", WALLET_CREDITED: "wallet_success",
  };
  const of = (phase: CustomerProgressPhase, spinner: boolean): CustomerProgress => ({
    phase, spinner, topUp, transactionType,
    progress: (phase === "SUCCESS" && (provider === "MANUAL" || order.completionMode === "ADMIN_OVERRIDE")) ? null : progressForPhase(phase),
    titleKey: `transaction.${copy[phase]}_title`, bodyKey: `transaction.${copy[phase]}_body`,
  });
  if (status === "DELIVERED") {
    if (transactionType === "WALLET_TOPUP") return of("WALLET_CREDITED", false);
    // A stock order is DELIVERED before its credentials file is sent; it is
    // only complete for the buyer once Telegram acknowledged that file.
    if (provider === "STOCK" && opts.credentialsDelivered === false) return of("DELIVERING", true);
    return of("SUCCESS", false);
  }
  if (status === "CREDITED_TO_BALANCE" || (status === "CANCELLED" && opts.credited)) return of("CREDITED", false);
  // A late authenticated payment can require credit review after cancellation.
  if (transactionType === "WALLET_TOPUP" && paymentStatusFor(order) === "PAID" && order.walletCreditState === "NEEDS_REVIEW") return of("REVIEW", false);
  if (["CANCELLED", "EXPIRED", "REFUNDED"].includes(status)) return of("CANCELLED", false);
  if (["FAILED", "REJECTED"].includes(status)) return of("FAILED", false);
  if (status === "PARTIALLY_DELIVERED") return of("REVIEW", false);
  const payment = paymentStatusFor(order);
  if (payment === "UNDERPAID") return of("UNDERPAID", false);
  if (payment === "PAYMENT_DETECTED") return of("PAYMENT_DETECTED", true);
  if (payment === "VERIFYING") return of("VERIFYING", true);
  if (transactionType === "WALLET_TOPUP" && payment === "PAID") {
    if (order.walletCreditState === "CREDITED") return of("WALLET_CREDITED", false);
    if (order.walletCreditState === "CREDITING") return of("WALLET_CREDITING", true);
    // No active credit operation is implied by a payment fact alone.
    return of("REVIEW", false);
  }
  if (status === "PENDING_VERIFICATION") return of("REVIEW", false);
  if (status === "PAID") return of(provider === "MANUAL" ? "MANUAL_WAITING" : "PAYMENT_CONFIRMED", provider !== "MANUAL");
  if (payment === "PAID" && status === "PENDING_PAYMENT") return of("REVIEW", false);
  if (status !== "PROCESSING" && status !== "PAID") return of("NONE", false);
  if (provider === "MANUAL") return of("MANUAL_WAITING", false);
  if (provider === "STOCK") return of("PREPARING", true);
  if (order.digiflazzStatus === "failed") return of("REVIEW", false);
  return of(!order.digiflazzDispatchedAt ? "AUTO_QUEUED" : (order.digiflazzAttempts ?? 0) === 0 ? "AUTO_SUBMITTING" : "AUTO_PROCESSING", true);
}
