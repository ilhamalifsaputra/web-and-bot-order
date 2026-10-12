/** Notification keys name facts, never infer payment from order creation. */
const definitions = [
  ["order.received.customer", "Order received", "Orders", "customer", "Your order was created. Payment and delivery are separate steps."],
  ["order.received.admin", "New order", "Orders", "admin", "A new order was created; it may still await payment."],
  ["payment.confirmed.customer", "Payment confirmed", "Payments", "customer", "Payment for your order was confirmed."],
  ["order.completed.customer", "Order completed", "Orders", "customer", "Your order has been fulfilled. View your order for delivery details."],
  ["order.failed.customer", "Order failed", "Orders", "customer", "Your order could not be fulfilled. Contact support for assistance."],
  ["order.failed.admin", "Final order failure", "Orders", "admin", "An order reached a final failure state. Review the order."],
  ["inventory.sku.critical", "Stock is low", "Inventory", "admin", "Available local stock crossed its critical threshold."],
  ["inventory.sku.out_of_stock", "Stock depleted", "Inventory", "admin", "A local stock SKU has no available units."],
  ["account.password_reset.requested", "Reset your password", "Account & Security", "customer", "A password reset was requested. Use the time limited link to choose a password."],
  ["payment.expired.customer", "Payment expired", "Payments", "customer", "The unpaid payment window expired. Do not pay the expired invoice."],
  ["payment.underpaid.customer", "Payment needs review", "Payments", "customer", "A verified payment was below the amount due. Contact support before sending more."],
  ["payment.underpaid.admin", "Underpayment detected", "Payments", "admin", "A verified payment was below the amount due. Review the payment evidence."],
  ["refund.initiated.customer", "Refund initiated", "Payments", "customer", "Your refund has entered processing. This does not confirm a payout."],
  ["refund.completed.customer", "Refund recorded", "Payments", "customer", "A refund payout was recorded. This does not guarantee arrival in an external account."],
  ["inventory.sku.restocked", "Stock recovered", "Inventory", "admin", "Available local stock recovered above its recovery threshold."],
  ["support.ticket.created.admin", "New support ticket", "Support", "admin", "A customer opened a support ticket."],
  ["support.ticket.created.customer", "Support request received", "Support", "customer", "Your support ticket was created."],
  ["support.ticket.replied.customer", "Support replied", "Support", "customer", "Support added a reply to your ticket. Sign in to read it."],
  ["security.login.suspicious", "Repeated sign in failures", "Account & Security", "customer", "Repeated unsuccessful password sign in attempts were detected for your account."],
  ["security.password.changed", "Password changed", "Account & Security", "customer", "Your password was changed. Contact support if you did not make this change."],
  ["provider.incident.opened", "Provider incident", "Provider Incidents", "admin", "Repeated provider failures crossed the incident threshold. Review service health."],
  ["report.daily_sales_inventory", "Daily sales and inventory", "Reports", "admin", "Summary of completed product orders and available local inventory for the closed reporting period."],
  ["report.weekly_revenue", "Weekly revenue", "Reports", "admin", "Completed product order revenue and recorded refunds for the closed reporting period."],
] as const;

export type EmailEventKey = (typeof definitions)[number][0];
export const EMAIL_EVENT_REGISTRY = definitions.map(([key, label, category, audience, description]) => ({
  key, label, category, audience, description,
  mandatory: key === "account.password_reset.requested",
  defaultEnabled: key === "account.password_reset.requested" || key === "order.completed.customer",
}));

/** Legacy facts outside the 23 keys keep their own policy, never become order.received. */
export const LEGACY_EMAIL_EXTENSIONS = {
  OWNER_EMAIL_ORDER_PAID: "legacy.owner_order_paid",
  OWNER_EMAIL_MANUAL_ORDER_QUEUED: "legacy.owner_manual_queue",
  OWNER_EMAIL_TICKET_REPLY: "legacy.owner_ticket_reply",
  OWNER_EMAIL_WALLET_TOPUP: "legacy.owner_wallet_topup",
} as const;
export function canonicalEmailEventFor(event: string): string {
  if (event === "BUYER_EMAIL_ORDER_READY") return "order.completed.customer";
  if (event === "OWNER_EMAIL_NEW_TICKET") return "support.ticket.created.admin";
  return LEGACY_EMAIL_EXTENSIONS[event as keyof typeof LEGACY_EMAIL_EXTENSIONS] ?? event;
}
